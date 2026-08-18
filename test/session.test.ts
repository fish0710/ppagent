import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAgentConfig } from '../src/agent/config/index.js';
import { createAgentSession } from '../src/agent/session.js';
import { StubAdmissionController } from '../src/agent/admission/index.js';
import { NonInteractiveInteraction } from '../src/app/cli/index.js';
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
  it('compacts on demand through a single cache-warm model call', async () => {
    const provider = new FauxProvider({
      turns: [textTurn('## Goal\nhand-written summary')],
    });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');
    const persisted: unknown[] = [];
    const events: UIEvent[] = [];
    const session = createAgentSession({
      config: mergeAgentConfig({
        context: { contextWindow: 2_000, keepRecentRatio: 0.05 },
      }),
      provider,
      model,
      cwd: process.cwd(),
      interaction: interaction(async () => false),
      admission: new StubAdmissionController(),
      context: {
        // user/assistant 轮流出现：user 消息不折叠，若整段历史全是 user，
        // 折叠区会被 selectCarriedUsers 原样搬空，摘要没有真正折叠掉任何
        // 东西（复述 + 保留一份重复），触发 IneffectiveCompactionError。
        // 混入 assistant 回复，让折叠路径依旧有实质内容可压缩。
        messages: Array.from({ length: 6 }, (_, index) => [
          {
            role: 'user' as const,
            content: `history ${index} ${'detail '.repeat(40)}`,
            timestamp: index * 2 + 1,
          },
          {
            role: 'assistant' as const,
            content: [{ type: 'text' as const, text: `reply ${index} ${'detail '.repeat(40)}` }],
            stopReason: 'stop' as const,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            timestamp: index * 2 + 2,
          },
        ]).flat(),
      },
      persistence: {
        async appendMessages() {},
        async appendCompaction(record) {
          persisted.push(record);
        },
      },
    });
    session.subscribe((event) => events.push(event));

    const result = await session.compact('重点记住失败过的命令');

    expect(result?.kind).toBe('summarize');
    expect(result?.meta?.modelCalls).toBe(1);
    expect(provider.pendingTurns()).toBe(0);
    expect(persisted).toHaveLength(1);
    expect(events.map((event) => event.type)).toEqual([
      'compact_start',
      'compacted',
    ]);
    expect(events[0]).toMatchObject({ trigger: 'manual' });
    // 压缩后的视图是 [摘要, ...保留的 user 消息, ...保留的最近消息]，顺序不变。
    expect(session.context.messages[0]).toMatchObject({ role: 'user' });
    expect(session.context.messages.length).toBeLessThan(12);
    expect(session.context.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: `reply 5 ${'detail '.repeat(40)}` }],
      stopReason: 'stop',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      timestamp: 12,
    });
  });

  it('reports a skipped compaction instead of leaving the UI mid-flight', async () => {
    const provider = new FauxProvider({ turns: [] });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');
    const events: UIEvent[] = [];
    const session = createAgentSession({
      config: mergeAgentConfig(),
      provider,
      model,
      cwd: process.cwd(),
      interaction: interaction(async () => false),
      admission: new StubAdmissionController(),
      context: { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] },
    });
    session.subscribe((event) => events.push(event));

    expect(await session.compact()).toBeNull();
    // compact_start 之后必须有收尾事件，否则界面停在压缩相位。
    expect(events.map((event) => event.type)).toEqual([
      'compact_start',
      'compact_skipped',
    ]);
  });


  it('runs the default subagent session and returns its final report to the parent', async () => {
    const provider = new FauxProvider({
      turns: [
        toolCallTurn({
          id: 'spawn-default',
          name: 'spawn_subagent',
          rawArguments: '{"task":"inspect module C"}',
          argumentChunkSize: 1,
        }),
        textTurn('module C report from child'),
        textTurn('parent incorporated module C report'),
      ],
    });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');
    const session = createAgentSession({
      config: mergeAgentConfig(),
      provider,
      model,
      cwd: process.cwd(),
      interaction: interaction(async () => false),
      admission: new StubAdmissionController(),
    });

    const result = await session.prompt('delegate with the default runner');

    expect(result).toMatchObject({ reason: 'stop', turns: 2 });
    expect(session.context.messages).toContainEqual(
      expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'spawn-default',
        isError: false,
        content: [{ type: 'text', text: 'module C report from child' }],
      }),
    );
    expect(session.context.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'parent incorporated module C report' }],
    });
  });

  it('registers spawn_subagent, returns its report, and emits admission denials', async () => {
    const acceptedProvider = new FauxProvider({
      turns: [
        toolCallTurn({
          id: 'spawn-ok',
          name: 'spawn_subagent',
          rawArguments: '{"task":"inspect module A"}',
          argumentChunkSize: 1,
        }),
        textTurn('used delegated report'),
      ],
    });
    const model = acceptedProvider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');
    const runSubagent = vi.fn(async () => ({ content: 'module A is healthy' }));
    const accepted = createAgentSession({
      config: mergeAgentConfig(),
      provider: acceptedProvider,
      model,
      cwd: process.cwd(),
      interaction: interaction(async () => false),
      subagentRunner: runSubagent,
    });

    await expect(accepted.prompt('delegate')).resolves.toMatchObject({ reason: 'stop' });
    expect(runSubagent).toHaveBeenCalledWith(
      'inspect module A',
      expect.objectContaining({ cwd: process.cwd() }),
    );
    expect(accepted.context.messages).toContainEqual(
      expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'spawn-ok',
        isError: false,
        content: [{ type: 'text', text: 'module A is healthy' }],
      }),
    );

    const deniedProvider = new FauxProvider({
      turns: [
        toolCallTurn({
          id: 'spawn-denied',
          name: 'spawn_subagent',
          rawArguments: '{"task":"inspect module B"}',
        }),
        textTurn('falling back to serial work'),
      ],
    });
    const deniedModel = deniedProvider.listModels()[0];
    if (deniedModel === undefined) throw new Error('Missing faux model');
    const denied = createAgentSession({
      config: mergeAgentConfig(),
      provider: deniedProvider,
      model: deniedModel,
      cwd: process.cwd(),
      interaction: interaction(async () => false),
      admission: new StubAdmissionController({
        ok: false,
        reason: 'memory pressure is high; continue serially',
        retryAfterMs: null,
      }),
      subagentRunner: runSubagent,
    });
    const events: UIEvent[] = [];
    denied.subscribe((event) => events.push(event));

    await denied.prompt('delegate under pressure');

    expect(events).toContainEqual({
      type: 'admission_denied',
      reason: 'memory pressure is high; continue serially',
      retryAfterMs: null,
    });
    expect(runSubagent).toHaveBeenCalledOnce();
    expect(denied.context.messages).toContainEqual(
      expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'spawn-denied',
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Admission denied: memory pressure is high; continue serially Do not retry; use a serial approach.',
          },
        ],
      }),
    );
  });
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
    const events: UIEvent[] = [];
    const interaction = new NonInteractiveInteraction((event) => {
      events.push({ type: 'notify', ...event });
    });
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
    expect(
      events
        .filter((event) =>
          [
            'permission_request',
            'notify',
            'permission_resolved',
            'tool_end',
          ].includes(event.type),
        )
        .map((event) => event.type),
    ).toEqual([
      'permission_request',
      'notify',
      'permission_resolved',
      'tool_end',
    ]);
    expect(events).toContainEqual({
      type: 'notify',
      level: 'warn',
      message: `Non-interactive mode automatically denied permission: ${command}`,
    });

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
