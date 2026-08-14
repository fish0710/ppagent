import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAgentConfig } from '../src/agent/config/index.js';
import { createAgentSession } from '../src/agent/session.js';
import {
  FauxProvider,
  textTurn,
  toolCallTurn,
} from '../src/core/llm/faux.js';
import type {
  Interaction,
  Provider,
  ReadonlyContext,
  UIEvent,
} from '../src/core/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe('AgentSession', () => {
  it('round-trips a denied privileged tool result back to the model', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ppagent-session-'));
    temporaryDirectories.push(cwd);
    const target = join(cwd, 'keep.txt');
    await writeFile(target, 'keep me');
    const command = `rm -f ${target}`;
    const faux = new FauxProvider({
      turns: [
        toolCallTurn({
          id: 'delete-call',
          name: 'bash',
          rawArguments: JSON.stringify({ cmd: command }),
          argumentChunkSize: 1,
        }),
        textTurn('I will leave the file unchanged.'),
      ],
    });
    const seenContexts: ReadonlyContext[] = [];
    const provider = recordingProvider(faux, seenContexts);
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');
    const confirm = vi.fn(async () => false);
    const interaction: Interaction = {
      confirm,
      ask: async () => null,
      select: async () => null,
      notify: () => undefined,
    };
    const events: UIEvent[] = [];
    const session = createAgentSession({
      config: mergeAgentConfig({ provider: { id: 'faux' } }),
      provider,
      model,
      cwd,
      interaction,
    });
    session.subscribe((event) => events.push(event));

    const result = await session.prompt(`Delete ${target}`);

    expect(result.reason).toBe('stop');
    await expect(access(target)).resolves.toBeUndefined();
    expect(confirm).toHaveBeenCalledWith({
      message: command,
      detail: JSON.stringify({ cmd: command }),
    });
    expect(events).toContainEqual({
      type: 'permission_resolved',
      decision: 'deny',
    });
    expect(
      events.some(
        (event) =>
          event.type === 'permission_request' &&
          event.req.summary === command,
      ),
    ).toBe(true);

    const secondTurn = seenContexts[1];
    expect(secondTurn).toBeDefined();
    const deniedResult = secondTurn?.messages.find(
      (message) => message.role === 'toolResult',
    );
    expect(deniedResult).toMatchObject({
      role: 'toolResult',
      toolCallId: 'delete-call',
      toolName: 'bash',
      isError: true,
      content: [{ type: 'text', text: 'User denied tool execution.' }],
    });
    expect(session.context.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'I will leave the file unchanged.' }],
    });
  });

  it('can replace the reverse channel between prompts', async () => {
    const firstConfirm = vi.fn(async () => false);
    const secondConfirm = vi.fn(async () => false);
    const provider = new FauxProvider({
      turns: [
        toolCallTurn({ name: 'bash', rawArguments: '{"cmd":"true"}' }),
        textTurn('first'),
        toolCallTurn({ name: 'bash', rawArguments: '{"cmd":"true"}' }),
        textTurn('second'),
      ],
    });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');
    const session = createAgentSession({
      config: mergeAgentConfig(),
      provider,
      model,
      cwd: process.cwd(),
      interaction: interaction(firstConfirm),
    });

    await session.prompt('one');
    session.setInteraction(interaction(secondConfirm));
    await session.prompt('two');

    expect(firstConfirm).toHaveBeenCalledOnce();
    expect(secondConfirm).toHaveBeenCalledOnce();
    expect(
      session.context.messages.filter((message) => message.role === 'user'),
    ).toHaveLength(2);
  });

  it('releases the in-progress guard when persistence fails', async () => {
    let failOnce = true;
    const provider = new FauxProvider({ turns: [textTurn('recovered')] });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');
    const session = createAgentSession({
      config: mergeAgentConfig(),
      provider,
      model,
      cwd: process.cwd(),
      interaction: interaction(async () => false),
      persistence: {
        async appendMessages() {
          if (!failOnce) return;
          failOnce = false;
          throw new Error('disk unavailable');
        },
        async appendCompaction() {},
      },
    });

    await expect(session.prompt('first')).rejects.toThrow('disk unavailable');
    await expect(session.prompt('second')).resolves.toMatchObject({
      reason: 'stop',
      turns: 1,
    });
  });
});

function recordingProvider(
  delegate: FauxProvider,
  seen: ReadonlyContext[],
): Provider {
  return {
    id: delegate.id,
    listModels: () => delegate.listModels(),
    stream(model, context, options) {
      seen.push(structuredClone(context));
      return delegate.stream(model, context, options);
    },
  };
}

function interaction(confirm: Interaction['confirm']): Interaction {
  return {
    confirm,
    ask: async () => null,
    select: async () => null,
    notify: () => undefined,
  };
}
