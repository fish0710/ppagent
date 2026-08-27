import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeAgentConfig } from '../src/agent/config/index.js';
import { createAgentSession } from '../src/agent/session.js';
import { StubAdmissionController } from '../src/agent/admission/index.js';
import { JsonlMemoryStore, type MemoryUsageLog } from '../src/agent/memory/index.js';
import { NonInteractiveInteraction } from '../src/app/cli/index.js';
import {
  FauxProvider,
  textTurn,
  toolCallTurn,
} from '../src/core/llm/faux.js';
import type {
  Interaction,
  MemoryRecord,
  MemoryStore,
  Provider,
  ReadonlyContext,
  ResourceProbe,
  ResourceSnapshot,
  UIEvent,
} from '../src/core/types.js';
import type {
  MemoryExtractionInput,
  MemoryExtractor,
} from '../src/agent/memory/index.js';

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

  describe('memory_search tool registration', () => {
    it('is not registered by default, even with memory.enabled and stores configured (config.memory.searchTool defaults to false)', async () => {
      const provider = new FauxProvider({
        turns: [
          toolCallTurn({ name: 'memory_search', rawArguments: '{"query":"npm"}' }),
          textTurn('fallback'),
        ],
      });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: new InMemoryMemoryStore(), user: new InMemoryMemoryStore() },
        projectKey: 'proj',
        resourceProbe: idleProbe(),
      });

      await session.prompt('search my memory');

      expect(session.context.messages).toContainEqual(
        expect.objectContaining({ role: 'toolResult', isError: true, content: [{ type: 'text', text: 'Unknown tool: memory_search' }] }),
      );
    });

    it('is registered when config.memory.searchTool is true and stores+projectKey are provided', async () => {
      const memoryStores = { project: new InMemoryMemoryStore(), user: new InMemoryMemoryStore() };
      await memoryStores.project.put(fakeRecord('m1', { text: 'npm run verify before commit' }));
      const provider = new FauxProvider({
        turns: [
          toolCallTurn({ name: 'memory_search', rawArguments: '{"query":"npm run verify"}' }),
          textTurn('found it'),
        ],
      });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true, searchTool: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores,
        projectKey: 'proj',
        resourceProbe: idleProbe(),
      });

      const result = await session.prompt('search my memory');

      expect(result.reason).toBe('stop');
      expect(session.context.messages).toContainEqual(
        expect.objectContaining({
          role: 'toolResult',
          isError: false,
          content: [{ type: 'text', text: expect.stringContaining('npm run verify before commit') }],
        }),
      );
    });
  });

  describe('memory usage tracking', () => {
    it('bumps exposure and adopted+adoptedOk when an injected memory is used and the task succeeds', async () => {
      const provider = new FauxProvider({
        turns: [toolCallTurn({ name: 'read', rawArguments: '{"path":"src/core/types.ts"}' }), textTurn('done')],
      });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      await store.put(fakeRecord('m1', { text: 'always check src/core/types.ts first' }));
      const injected = [fakeRecord('m1', { text: 'always check src/core/types.ts first' })];
      const logged: unknown[] = [];
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        injectedMemories: injected,
        sessionId: 'session-x',
        memoryUsageLog: fakeUsageLog(async (entry) => void logged.push(entry)),
      });

      await session.prompt('do the thing');

      const [record] = await store.all();
      expect(record).toMatchObject({ exposure: 1, adopted: 1, adoptedOk: 1, adoptedBad: 0, status: 'active' });
      expect(logged).toEqual([
        {
          timestamp: expect.any(Number),
          sessionId: 'session-x',
          injectedIds: ['m1'],
          adoptedIds: ['m1'],
          loopEndReason: 'stop',
          turns: expect.any(Number),
        },
      ]);
    });

    it('bumps exposure but not adopted when the injected memory is never used', async () => {
      const provider = new FauxProvider({ turns: [textTurn('done, no files touched')] });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      await store.put(fakeRecord('m1', { text: 'always check src/core/types.ts first' }));
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        injectedMemories: [fakeRecord('m1', { text: 'always check src/core/types.ts first' })],
        resourceProbe: idleProbe(),
      });

      await session.prompt('do the thing');

      const [record] = await store.all();
      expect(record).toMatchObject({ exposure: 1, adopted: 0, adoptedOk: 0, adoptedBad: 0 });
    });

    it('deprecates a record once adopted >= 3 and more than half of those adoptions ended badly', async () => {
      const seed = {
        text: 'always check src/core/types.ts first',
        adopted: 2,
        adoptedBad: 2,
        adoptedOk: 0,
      };
      const store = new InMemoryMemoryStore();
      // 已经背了 2 次不良采纳（这次会话前的历史），还没到 adopted>=3 的门槛。
      await store.put(fakeRecord('m1', seed));
      const provider = new FauxProvider({
        turns: [toolCallTurn({ name: 'read', rawArguments: '{"path":"src/core/types.ts"}' })],
      });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true }, loop: { maxTurns: 1 } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        injectedMemories: [fakeRecord('m1', seed)],
        resourceProbe: idleProbe(),
      });

      const result = await session.prompt('do the thing');

      expect(result.reason).toBe('maxTurns');
      const [record] = await store.all();
      // 这次采纳且以 maxTurns 收尾：adopted 3, adoptedBad 3 → 3/3 > 0.5 且 adopted>=3。
      expect(record).toMatchObject({ adopted: 3, adoptedBad: 3, status: 'deprecated' });
    });

    it('counts exposure and adoption on an aborted session without moving adoptedOk or adoptedBad', async () => {
      const provider = new FauxProvider({
        turns: [toolCallTurn({ name: 'read', rawArguments: '{"path":"src/core/types.ts"}', delayMs: 50 })],
      });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      await store.put(fakeRecord('m1', { text: 'always check src/core/types.ts first' }));
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        injectedMemories: [fakeRecord('m1', { text: 'always check src/core/types.ts first' })],
        resourceProbe: idleProbe(),
      });

      const prompt = session.prompt('slow task');
      setTimeout(() => session.abort(new Error('user cancelled')), 5);
      const result = await prompt;

      expect(result.reason).toBe('aborted');
      const [record] = await store.all();
      expect(record).toMatchObject({ exposure: 1, adoptedOk: 0, adoptedBad: 0 });
    });

    it('does nothing when no memories were injected this session', async () => {
      const provider = new FauxProvider({ turns: [textTurn('ok')] });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        resourceProbe: idleProbe(),
      });

      await expect(session.prompt('do the thing')).resolves.toMatchObject({ reason: 'stop' });
      expect(await store.all()).toEqual([]);
    });

    it('never lets a broken usage log reject prompt()', async () => {
      const provider = new FauxProvider({ turns: [textTurn('ok')] });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      await store.put(fakeRecord('m1'));
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        injectedMemories: [fakeRecord('m1')],
        memoryUsageLog: fakeUsageLog(async () => {
          throw new Error('disk full');
        }),
        resourceProbe: idleProbe(),
      });

      await expect(session.prompt('do the thing')).resolves.toMatchObject({ reason: 'stop' });
    });
  });

  describe('memory extraction', () => {
    it('end-to-end with the real LlmMemoryExtractor and a real JsonlMemoryStore on disk (no fakes)', async () => {
      const provider = new FauxProvider({
        turns: [
          textTurn('done, added retries'),
          textTurn(
            '## Durable conventions\nalways run npm run verify before committing',
          ),
        ],
      });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const root = await mkdtemp(join(tmpdir(), 'ppagent-memory-e2e-'));
      temporaryDirectories.push(root);
      const store = new JsonlMemoryStore({ rootDirectory: root });
      const session = createAgentSession({
        config: mergeAgentConfig({
          memory: { enabled: true, extractTimeoutMs: 5_000 },
        }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        projectKey: 'proj-real',
        sessionId: 'session-real',
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        resourceProbe: idleProbe(),
      });

      const result = await session.prompt('add retries to the fetch layer');

      expect(result.reason).toBe('stop');
      const persisted = await store.all();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        kind: 'convention',
        text: 'always run npm run verify before committing',
        scope: 'project',
        projectKey: 'proj-real',
        sourceSessionId: 'session-real',
        status: 'active',
      });
    });

    it('writes extracted records to the project store when everything is enabled', async () => {
      const provider = new FauxProvider({ turns: [textTurn('ok')] });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      const captured: MemoryExtractionInput[] = [];
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        projectKey: 'proj',
        sessionId: 'session-x',
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        memoryExtractor: fakeExtractor(captured, [fakeRecord('mem-1')]),
        resourceProbe: idleProbe(),
      });

      const result = await session.prompt('add retries');

      expect(result.reason).toBe('stop');
      expect(captured).toHaveLength(1);
      expect(captured[0]).toMatchObject({
        sourceSessionId: 'session-x',
        projectKey: 'proj',
        loopEndReason: 'stop',
      });
      expect(await store.all()).toEqual([fakeRecord('mem-1')]);
    });

    it('does not extract when memory is disabled in config', async () => {
      const provider = new FauxProvider({ turns: [textTurn('ok')] });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      const captured: MemoryExtractionInput[] = [];
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: false } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        memoryExtractor: fakeExtractor(captured, [fakeRecord('mem-1')]),
        resourceProbe: idleProbe(),
      });

      await session.prompt('add retries');

      expect(captured).toHaveLength(0);
      expect(await store.all()).toEqual([]);
    });

    it('does not extract when no memoryStores are configured, even if config.memory.enabled is true', async () => {
      const provider = new FauxProvider({ turns: [textTurn('ok')] });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const captured: MemoryExtractionInput[] = [];
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryExtractor: fakeExtractor(captured, [fakeRecord('mem-1')]),
        resourceProbe: idleProbe(),
      });

      await session.prompt('add retries');

      expect(captured).toHaveLength(0);
    });

    it('does not extract when the loop was aborted by the user', async () => {
      const provider = new FauxProvider({
        turns: [textTurn('working...', { delayMs: 50 })],
      });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      const captured: MemoryExtractionInput[] = [];
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        memoryExtractor: fakeExtractor(captured, [fakeRecord('mem-1')]),
        resourceProbe: idleProbe(),
      });

      const prompt = session.prompt('slow task');
      setTimeout(() => session.abort(new Error('user cancelled')), 5);
      const result = await prompt;

      expect(result.reason).toBe('aborted');
      expect(captured).toHaveLength(0);
    });

    it('skips extraction (without throwing) when the resource probe reports the GPU busy', async () => {
      const provider = new FauxProvider({ turns: [textTurn('ok')] });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const store = new InMemoryMemoryStore();
      const captured: MemoryExtractionInput[] = [];
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: store, user: new InMemoryMemoryStore() },
        memoryExtractor: fakeExtractor(captured, [fakeRecord('mem-1')]),
        resourceProbe: busyProbe(),
      });

      const result = await session.prompt('add retries');

      expect(result.reason).toBe('stop');
      expect(captured).toHaveLength(0);
      expect(await store.all()).toEqual([]);
    });

    it('never lets an unexpected extractor failure reject prompt()', async () => {
      const provider = new FauxProvider({ turns: [textTurn('ok')] });
      const model = provider.listModels()[0];
      if (model === undefined) throw new Error('Missing faux model');
      const throwingExtractor: MemoryExtractor = {
        extract: () => {
          throw new Error('boom');
        },
      };
      const session = createAgentSession({
        config: mergeAgentConfig({ memory: { enabled: true } }),
        provider,
        model,
        cwd: process.cwd(),
        interaction: interaction(async () => false),
        memoryStores: { project: new InMemoryMemoryStore(), user: new InMemoryMemoryStore() },
        memoryExtractor: throwingExtractor,
        resourceProbe: idleProbe(),
      });

      await expect(session.prompt('add retries')).resolves.toMatchObject({ reason: 'stop' });
    });
  });
});

class InMemoryMemoryStore implements MemoryStore {
  #records = new Map<string, MemoryRecord>();

  async put(record: MemoryRecord): Promise<void> {
    this.#records.set(record.id, record);
  }

  async all(): Promise<MemoryRecord[]> {
    return [...this.#records.values()];
  }

  async patch(id: string, patch: Partial<MemoryRecord>): Promise<void> {
    const existing = this.#records.get(id);
    if (existing === undefined) throw new Error(`Unknown memory record: ${id}`);
    this.#records.set(id, { ...existing, ...patch, id });
  }

  async remove(id: string): Promise<void> {
    this.#records.delete(id);
  }
}

function fakeRecord(id: string, overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id,
    scope: 'project',
    kind: 'fact',
    text: 'placeholder',
    projectKey: 'proj',
    sourceSessionId: 'session-x',
    createdAt: 0,
    updatedAt: 0,
    status: 'active',
    exposure: 0,
    adopted: 0,
    adoptedOk: 0,
    adoptedBad: 0,
    ...overrides,
  };
}

function fakeExtractor(
  captured: MemoryExtractionInput[],
  records: MemoryRecord[],
): MemoryExtractor {
  return {
    async extract(input) {
      captured.push(input);
      return records;
    },
  };
}

function fakeUsageLog(append: MemoryUsageLog['append']): MemoryUsageLog {
  return { append, readAll: async () => [] };
}

function idleProbe(): ResourceProbe {
  return { snapshot: async () => resourceSnapshot({ gpuBusy: false, memPressure: 0.1 }) };
}

function busyProbe(): ResourceProbe {
  return { snapshot: async () => resourceSnapshot({ gpuBusy: true, memPressure: 0.1 }) };
}

function resourceSnapshot(overrides: Partial<ResourceSnapshot>): ResourceSnapshot {
  return {
    source: 'test',
    memPressure: 0,
    memAvailableMB: 8_192,
    gpuBusy: false,
    activeSubagents: 0,
    sampledAt: 0,
    ...overrides,
  };
}

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

/**
 * InteractivePermissionPolicy 现在走 select()，不再走 confirm()；这个 helper
 * 接受一个"confirm 形状"的 mock（沿用既有测试写法 async () => boolean），
 * 内部转发到 select()，这样调用方原有的 vi.fn 断言（toHaveBeenCalledOnce 等）
 * 依然生效。
 */
function interaction(confirm: (req: { message: string; detail?: string }) => Promise<boolean>): Interaction {
  return {
    confirm,
    ask: async () => null,
    select: async (req) => ((await confirm(req)) ? 'allow' : 'deny'),
    notify: () => undefined,
  };
}
