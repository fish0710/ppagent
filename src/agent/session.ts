import type { AgentConfig } from './config/index.js';
import { ResourceAdmissionController } from './admission/index.js';
import { InteractivePermissionPolicy } from './permissions/index.js';
import {
  createSpawnSubagentTool,
  type SpawnSubagentRunner,
} from './tools/spawn-subagent.js';
import { createMemorySearchTool } from './tools/memory-search.js';
import { StructuralSummarizer } from '../core/context/compact.js';
import { ThresholdCompactPolicy } from '../core/context/compact.js';
import { LlmSummarizer } from './summarize/llm.js';
import {
  LlmMemoryExtractor,
  patchMemoryRecord,
  writeMemoryRecord,
  type MemoryExtractor,
  type MemoryStores,
  type MemoryUsageLog,
} from './memory/index.js';
import { detectAdoption } from '../core/memory/adopt.js';
import { ContextManager } from '../core/context/manager.js';
import { O200kTokenCounter } from '../core/context/tokenizer.js';
import type {
  AgentLoopPersistence,
  AgentLoopResult,
  AgentLoopTelemetryOptions,
} from '../core/loop/index.js';
import { runAgentLoop } from '../core/loop/index.js';
import { PassthroughSandbox } from '../core/sandbox/passthrough.js';
import { MacOsSandbox } from '../core/sandbox/macos.js';
import {
  MacOsResourceProbe,
  ResourceActivityTracker,
  SystemResourceProbe,
} from '../core/resource/index.js';
import {
  createTraceContext,
  flushSpanExporter,
} from '../core/telemetry/index.js';
import {
  createBuiltinTools,
  createBuiltinToolRegistry,
} from '../core/tools/builtin/index.js';
import type {
  AdmissionController,
  CompactResult,
  Context,
  Interaction,
  MemoryRecord,
  Message,
  ModelRef,
  PermissionPolicy,
  Provider,
  ReadonlyContext,
  ResourceProbe,
  Sandbox,
  SessionId,
  StreamOptions,
  Summarizer,
  TokenCounter,
  ToolContext,
  TraceContext,
  UIEvent,
} from '../core/types.js';
import { ToolRegistry } from '../core/tools/registry.js';

export interface AgentSession {
  prompt(text: string): Promise<AgentLoopResult>;
  /** 手动压缩上下文；instructions 会附加到摘要指令之后，聚焦本次摘要重点。 */
  compact(instructions?: string): Promise<CompactResult | null>;
  abort(reason?: unknown): void;
  subscribe(handler: (event: UIEvent) => void): () => void;
  setInteraction(interaction: Interaction): void;
  readonly context: ReadonlyContext;
}

export interface AgentSessionOptions {
  config: AgentConfig;
  provider: Provider;
  model: ModelRef;
  cwd: string;
  interaction: Interaction;
  context?: Context;
  previousSummary?: Message;
  /** 紧跟在 previousSummary 之后、原样保留的 user 消息块；--resume 恢复时用。 */
  previousCarried?: readonly Message[];
  persistence?: AgentLoopPersistence;
  telemetry?: AgentLoopTelemetryOptions;
  registry?: ToolRegistry;
  admission?: AdmissionController;
  permissions?: PermissionPolicy;
  sandbox?: Sandbox;
  resourceProbe?: ResourceProbe;
  resourceActivity?: ResourceActivityTracker;
  tokenCounter?: TokenCounter;
  subagentRunner?: SpawnSubagentRunner;
  /** 子 session 共享 exporter 时由最外层统一 flush，避免提前拆散 span 树。 */
  flushTelemetryOnPrompt?: boolean;
  now?: () => number;
  traceFactory?: () => TraceContext;
  /** 记忆写入目标；未提供时即使 config.memory.enabled 也不抽取——没地方写等同于关闭。 */
  memoryStores?: MemoryStores;
  /** project scope 记忆的归属键；调用方（bin/agent.ts）已经为检索算过一次，这里复用，不重复起 git 子进程。 */
  projectKey?: string;
  /** 测试注入；未提供时用 LlmMemoryExtractor。 */
  memoryExtractor?: MemoryExtractor;
  /** 记忆记录的 sourceSessionId；未提供时用 'ephemeral'（没有 --session 的一次性会话）。 */
  sessionId?: SessionId;
  /**
   * 本次会话真正注入 systemPrompt 的记忆记录（调用方从 retrieveMemoryBlock
   * 的 included 里拿到）。用于曝光计数与采纳检测；--resume 路径下调用方不会
   * 提供这个字段（原始选中的具体记录没有持久化），resume 出的会话不参与
   * 曝光/采纳反馈——这是 v1 接受的已知缺口。
   */
  injectedMemories?: readonly MemoryRecord[];
  /** 采纳反馈的落盘目标；未提供时曝光计数/采纳检测正常算，但不写事件流。 */
  memoryUsageLog?: MemoryUsageLog;
}

/**
 * agent/ 层的唯一装配点：配置在进入这里前已经合并，core 只收到各自需要的
 * 构造参数。Interaction 通过代理反向调用应用层，不把 readline 带进 core。
 */
export class DefaultAgentSession implements AgentSession {
  readonly #options: AgentSessionOptions;
  readonly #subscribers = new Set<(event: UIEvent) => void>();
  readonly #registry: ToolRegistry;
  readonly #provider: Provider;
  readonly #admission: AdmissionController;
  readonly #permissions: PermissionPolicy;
  readonly #sandbox: Sandbox;
  readonly #now: () => number;
  readonly #traceFactory: () => TraceContext;
  readonly #resourceProbe: ResourceProbe;
  readonly #resourceActivity: ResourceActivityTracker;
  readonly #tokenCounter: TokenCounter;
  #context: Context;
  #previousSummary: Message | undefined;
  #previousCarried: readonly Message[] = [];
  #interaction: Interaction;
  #controller: AbortController | undefined;

  constructor(options: AgentSessionOptions) {
    this.#options = options;
    this.#context = structuredClone(options.context ?? { messages: [] });
    this.#previousSummary =
      options.previousSummary === undefined
        ? undefined
        : structuredClone(options.previousSummary);
    this.#previousCarried =
      options.previousCarried === undefined
        ? []
        : (structuredClone(options.previousCarried) as Message[]);
    this.#interaction = options.interaction;
    this.#resourceActivity = options.resourceActivity ?? new ResourceActivityTracker();
    this.#resourceProbe =
      options.resourceProbe ??
      (process.platform === 'darwin'
        ? new MacOsResourceProbe({
            activity: this.#resourceActivity,
            cacheMs: options.config.resource.probeCacheMs,
          })
        : new SystemResourceProbe(this.#resourceActivity));
    this.#provider = trackProvider(options.provider, this.#resourceActivity);
    if (isLocalProvider(options.model.provider) && options.tokenCounter === undefined) {
      throw new Error(
        'Local models require an explicit TokenCounter selection; call createTokenCounter() before creating the session.',
      );
    }
    this.#tokenCounter = options.tokenCounter ?? new O200kTokenCounter();
    this.#admission =
      options.admission ??
      new ResourceAdmissionController({
        probe: this.#resourceProbe,
        activity: this.#resourceActivity,
        config: {
          minMemAvailableMB: options.config.resource.minSubagentMemMB,
          maxSubagents: options.config.resource.maxSubagents,
          lowMemoryRetryAfterMs: options.config.resource.lowMemoryRetryAfterMs,
          busyGpuRetryAfterMs: options.config.resource.busyGpuRetryAfterMs,
        },
      });
    this.#permissions = options.permissions ?? new InteractivePermissionPolicy();
    this.#sandbox =
      options.sandbox ??
      (process.platform === 'darwin'
        ? new MacOsSandbox({
            cwd: options.cwd,
            networkAllowlist: options.config.sandbox.networkAllowlist,
          })
        : new PassthroughSandbox());
    this.#registry =
      options.registry ??
      new ToolRegistry([
        ...createBuiltinTools(),
        createSpawnSubagentTool(
          options.subagentRunner ?? ((task, context) => this.#runSubagent(task, context)),
        ),
        // 默认不注册：工具定义会被 chat template 渲染进 system 段，每次
        // 请求都计费；config.memory.searchTool 关闭时这里什么都不加。
        // 也需要 memoryStores/projectKey——没地方查、不知道查哪个项目，
        // 注册了也是摆设。
        ...(options.config.memory.searchTool &&
        options.memoryStores !== undefined &&
        options.projectKey !== undefined
          ? [
              createMemorySearchTool({
                stores: options.memoryStores,
                projectKey: options.projectKey,
              }),
            ]
          : []),
      ]);
    this.#now = options.now ?? Date.now;
    this.#traceFactory = options.traceFactory ?? createTraceContext;
  }

  get context(): ReadonlyContext {
    return this.#context;
  }

  /**
   * 手动压缩。自动压缩在每轮模型调用前触发，这里给用户一个提前动手的入口 ——
   * 知道接下来要干一件大活时先腾地方，比撞到阈值时被动压缩更可控。
   *
   * 返回 null 表示没做：历史太短没有可折叠的部分，或者压缩后反而更大。
   */
  async compact(instructions?: string): Promise<CompactResult | null> {
    if (this.#controller !== undefined) {
      throw new Error('AgentSession already has a prompt in progress');
    }
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const config = this.#options.config;
      const contextWindow =
        config.context.contextWindow ?? this.#options.model.contextWindow;
      const manager = new ContextManager({
        context: this.#context,
        tokenCounter: this.#tokenCounter,
        ...(this.#previousSummary === undefined
          ? {}
          : { previousSummary: this.#previousSummary }),
        previousCarried: this.#previousCarried,
      });
      this.#emit({ type: 'compact_start', trigger: 'manual' });
      const result = await manager.compact('manual', {
        policy: new ThresholdCompactPolicy({
          config: config.context,
          tokenCounter: this.#tokenCounter,
        }),
        summarizer: this.#createSummarizer(),
        contextWindow,
        targetTokens: config.context.summaryMaxTokens,
        ...(instructions === undefined ? {} : { instructions }),
        signal: controller.signal,
        trace: this.#traceFactory(),
      });
      if (result === null) {
        // compact_start 已经发过，必须有收尾事件，否则界面停在压缩相位。
        this.#emit({
          type: 'compact_skipped',
          trigger: 'manual',
          reason: '没有可折叠的历史，上下文保持不变',
        });
        return null;
      }
      this.#context = manager.snapshot();
      if (result.kind === 'summarize' && result.summary !== undefined) {
        this.#applyCompactionResult(result);
        await this.#options.persistence?.appendCompaction(result);
      }
      this.#emit({
        type: 'compacted',
        trigger: result.trigger,
        kind: result.kind,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        prunedCount: result.prunedCount,
        ...(result.meta === undefined ? {} : { strategy: result.meta.strategy }),
      });
      return result;
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
    }
  }

  async prompt(text: string): Promise<AgentLoopResult> {
    if (text.trim().length === 0) throw new Error('Prompt must not be empty');
    if (this.#controller !== undefined) {
      throw new Error('AgentSession already has a prompt in progress');
    }
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const userMessage: Message = {
        role: 'user',
        content: text,
        timestamp: this.#now(),
      };
      await this.#options.persistence?.appendMessages([userMessage]);
      this.#context.messages.push(userMessage);

      const tokenCounter = this.#tokenCounter;
      const config = this.#options.config;
      const contextWindow =
        config.context.contextWindow ?? this.#options.model.contextWindow;
      const streamOptions: Omit<StreamOptions, 'signal'> = {
        ...(config.provider.maxOutputTokens === undefined
          ? {}
          : { maxTokens: config.provider.maxOutputTokens }),
        ...(config.provider.effort === undefined
          ? {}
          : { effort: config.provider.effort }),
        ...(config.provider.requestTimeoutMs === undefined
          ? {}
          : { timeoutMs: config.provider.requestTimeoutMs }),
        ...(config.provider.maxRetries === undefined
          ? {}
          : { maxRetries: config.provider.maxRetries }),
      };
      const persistence: AgentLoopPersistence = {
        appendMessages: async (messages) =>
          this.#options.persistence?.appendMessages(messages),
        appendCompaction: async (result) => {
          this.#applyCompactionResult(result);
          await this.#options.persistence?.appendCompaction(result);
        },
      };
      const result = await runAgentLoop({
        provider: this.#provider,
        model: this.#options.model,
        context: this.#context,
        registry: this.#registry,
        toolContext: {
          signal: controller.signal,
          cwd: this.#options.cwd,
          trace: this.#traceFactory(),
          interaction: this.#interactionProxy(),
        },
        toolDeps: {
          admission: this.#observableAdmission(),
          permissions: this.#observablePermissions(),
          sandbox: this.#sandbox,
        },
        toolOptions: {
          maxResultChars: config.tools.maxResultChars,
          toolTimeoutMs: config.tools.toolTimeoutMs,
        },
        loopConfig: config.loop,
        maxToolConcurrency: config.tools.maxConcurrency,
        ...(Object.keys(streamOptions).length === 0 ? {} : { streamOptions }),
        compaction: {
          tokenCounter,
          policy: new ThresholdCompactPolicy({
            config: config.context,
            tokenCounter,
          }),
          summarizer: this.#createSummarizer(),
          contextWindow,
          targetTokens: config.context.summaryMaxTokens,
          ...(this.#previousSummary === undefined
            ? {}
            : { previousSummary: this.#previousSummary }),
          previousCarried: this.#previousCarried,
          resourceProbe: this.#resourceProbe,
        },
        persistence,
        ...(this.#options.telemetry === undefined
          ? {}
          : { telemetry: this.#options.telemetry }),
        emit: (event) => this.#emit(event),
      });
      this.#context = result.context;
      await this.#trackMemoryUsage(result);
      await this.#extractMemory(result, controller.signal);
      return result;
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
      if (this.#options.flushTelemetryOnPrompt !== false) {
        await flushSpanExporter(this.#options.telemetry?.exporter);
      }
    }
  }

  abort(reason: unknown = new Error('Agent session aborted')): void {
    this.#controller?.abort(reason);
  }

  subscribe(handler: (event: UIEvent) => void): () => void {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }

  setInteraction(interaction: Interaction): void {
    this.#interaction = interaction;
  }

  /**
   * summarize 结果落地后同步更新 previousSummary/previousCarried —— 下一次
   * 压缩（无论是自动触发还是手动 /compact）都要从这里接着累积。
   */
  #applyCompactionResult(result: CompactResult): void {
    if (result.kind !== 'summarize' || result.summary === undefined) return;
    this.#previousSummary = structuredClone(result.summary);
    if (result.keptUserIndices !== undefined) {
      // result.messages = [summary, ...carried, ...retained]；carried 的长度
      // 就是 keptUserIndices 的长度，直接切片即可，不需要重新按角色扫描——
      // 那样会把 retained 开头凑巧是 user 的消息也当成 carried 的一部分。
      this.#previousCarried = result.messages.slice(1, 1 + result.keptUserIndices.length);
    }
  }

  /**
   * 规则摘要器永远存在，LLM 摘要器包在它外面。
   *
   * 只能在这里构造：LlmSummarizer 需要 Provider，而 core/context 不许认识
   * core/llm（depcruise core-no-upward），需要模型的策略只能由装配层注入。
   */
  #createSummarizer(): Summarizer {
    const config = this.#options.config;
    const structural = new StructuralSummarizer({
      tokenCounter: this.#tokenCounter,
    });
    if (!config.context.llmSummarizer) return structural;
    return new LlmSummarizer({
      provider: this.#provider,
      model: this.#options.model,
      tokenCounter: this.#tokenCounter,
      fallback: structural,
      maxTokens: config.context.summaryMaxTokens,
      timeoutMs: config.context.summarizeTimeoutMs,
      notify: (message) => this.#emit({ type: 'notify', level: 'warn', message }),
      now: this.#now,
    });
  }

  /**
   * 曝光计数 + 采纳检测 + deprecate 规则，三件事绑在一起做，因为它们共享
   * 同一份 injectedMemories 和同一次 detectAdoption 调用结果。不调模型，
   * 不受 GPU 忙的门禁约束——纯粹是磁盘读写。
   *
   * deprecate 规则只做优先级最高的那条：一条记忆被反复采纳却经常导向
   * maxTurns/error，是在主动误导 agent，危害远大于一条从没被召回的记忆
   * （落地计划第 3.6 节）。'aborted' 既不算好也不算坏——用户主动取消不是
   * 这条记忆的锅，只计曝光和采纳，不进 adoptedOk/adoptedBad 的任何一边。
   */
  async #trackMemoryUsage(result: AgentLoopResult): Promise<void> {
    const config = this.#options.config;
    if (!config.memory.enabled) return;
    if (this.#options.memoryStores === undefined) return;
    const injected = this.#options.injectedMemories;
    if (injected === undefined || injected.length === 0) return;
    try {
      const detections = detectAdoption(injected, this.#context.messages);
      const adoptedIds: string[] = [];
      for (const record of injected) {
        const isAdopted =
          detections.find((entry) => entry.memoryId === record.id)?.adopted ?? false;
        if (isAdopted) adoptedIds.push(record.id);
        const exposure = record.exposure + 1;
        const adopted = record.adopted + (isAdopted ? 1 : 0);
        const adoptedOk =
          record.adoptedOk + (isAdopted && result.reason === 'stop' ? 1 : 0);
        const adoptedBad =
          record.adoptedBad +
          (isAdopted && (result.reason === 'maxTurns' || result.reason === 'error') ? 1 : 0);
        const shouldDeprecate = adopted >= 3 && adoptedBad / adopted > 0.5;
        await patchMemoryRecord(this.#options.memoryStores, record.scope, record.id, {
          exposure,
          adopted,
          adoptedOk,
          adoptedBad,
          ...(shouldDeprecate ? { status: 'deprecated' } : {}),
        });
      }
      await this.#options.memoryUsageLog?.append({
        timestamp: this.#now(),
        sessionId: this.#options.sessionId ?? 'ephemeral',
        injectedIds: injected.map((record) => record.id),
        adoptedIds,
        loopEndReason: result.reason,
        turns: result.turns,
      });
    } catch {
      // 采纳反馈是锦上添花；任何失败都不该影响已经产出的任务结果。
    }
  }

  /**
   * 任务级抽取，跟在压缩摘要同一套"失败降级"纪律下：任何未预料的失败都
   * 不该反过来污染已经产出的 AgentLoopResult，所以整体包一层 try/catch，
   * 即使 LlmMemoryExtractor 自己已经不抛（见 extract.ts 的文档），这里
   * 仍然按"防御第二层"处理——未来换一个不遵守这条约定的 MemoryExtractor
   * 实现时，这层兜底还在。
   *
   * 三道门禁，任一不满足就直接跳过，不排队不重试：
   *   1. 没配 memoryStores（没地方写，等同于关闭）
   *   2. loop 以 aborted 结束（用户主动取消，不产出任何教训）
   *   3. GPU 忙或内存压力已经到压缩阈值（本地只有一块 GPU，这次任务的
   *      推理请求不该为一次锦上添花的抽取让路）
   */
  async #extractMemory(result: AgentLoopResult, signal: AbortSignal): Promise<void> {
    const config = this.#options.config;
    if (!config.memory.enabled) return;
    if (this.#options.memoryStores === undefined) return;
    if (result.reason === 'aborted') return;
    try {
      const snapshot = await this.#resourceProbe.snapshot();
      if (snapshot.gpuBusy || snapshot.memPressure >= config.context.memPressureThreshold) {
        return;
      }
      const records = await this.#memoryExtractor().extract(
        {
          sourceSessionId: this.#options.sessionId ?? 'ephemeral',
          projectKey: this.#options.projectKey ?? '',
          messages: this.#context.messages,
          loopEndReason: result.reason,
          ...(this.#previousSummary === undefined
            ? {}
            : { previousSummary: this.#previousSummary }),
          maxTrackedFiles: config.context.maxTrackedFiles,
        },
        signal,
      );
      for (const record of records) {
        await writeMemoryRecord(this.#options.memoryStores, record);
      }
    } catch {
      // 记忆抽取是锦上添花；任何失败都不该影响已经产出的任务结果。
    }
  }

  #memoryExtractor(): MemoryExtractor {
    if (this.#options.memoryExtractor !== undefined) return this.#options.memoryExtractor;
    const config = this.#options.config;
    return new LlmMemoryExtractor({
      provider: this.#provider,
      model: this.#options.model,
      maxTokens: config.memory.extractMaxTokens,
      timeoutMs: config.memory.extractTimeoutMs,
      notify: (message) => this.#emit({ type: 'notify', level: 'warn', message }),
      now: this.#now,
    });
  }

  #emit(event: UIEvent): void {
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(event);
      } catch {
        // UI 订阅者与遥测一样是旁路，不能打断 agent。
      }
    }
  }

  #observablePermissions(): PermissionPolicy {
    return {
      check: async (request, interaction) => {
        this.#emit({ type: 'permission_request', req: request });
        const decision = await this.#permissions.check(request, interaction);
        this.#emit({ type: 'permission_resolved', decision });
        return decision;
      },
    };
  }

  #observableAdmission(): AdmissionController {
    return {
      canSpawnSubagent: async () => {
        const decision = await this.#admission.canSpawnSubagent();
        if (!decision.ok) {
          this.#emit({
            type: 'admission_denied',
            reason: decision.reason ?? 'resource limits',
            retryAfterMs: decision.retryAfterMs ?? null,
          });
        }
        return decision;
      },
      releaseSubagent: () => this.#admission.releaseSubagent?.(),
    };
  }

  async #runSubagent(
    task: string,
    context: ToolContext,
  ): ReturnType<SpawnSubagentRunner> {
    if (context.signal.aborted) {
      return {
        content: 'Subagent was not started because the parent task was aborted.',
        isError: true,
      };
    }
    const child = createAgentSession({
      config: this.#options.config,
      provider: this.#options.provider,
      model: this.#options.model,
      cwd: this.#options.cwd,
      interaction: this.#interactionProxy(),
      registry: createBuiltinToolRegistry(),
      admission: this.#admission,
      permissions: this.#permissions,
      sandbox: this.#sandbox,
      resourceProbe: this.#resourceProbe,
      resourceActivity: this.#resourceActivity,
      tokenCounter: this.#tokenCounter,
      ...(this.#options.telemetry === undefined
        ? {}
        : { telemetry: this.#options.telemetry }),
      flushTelemetryOnPrompt: false,
      traceFactory: () => context.trace.child('subagent'),
    });
    const onAbort = (): void => child.abort(context.signal.reason);
    const prompt = child.prompt(task);
    if (context.signal.aborted) onAbort();
    else context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await prompt;
      const content = lastAssistantText(result.context) || '(subagent returned no text)';
      return {
        content:
          result.reason === 'stop'
            ? content
            : `[Subagent ended with ${result.reason}]\n${content}`,
        ...(result.reason === 'stop' ? {} : { isError: true }),
      };
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  }

  #interactionProxy(): Interaction {
    return {
      confirm: (request) => this.#interaction.confirm(request),
      ask: (request) => this.#interaction.ask(request),
      select: (request) => this.#interaction.select(request),
      notify: (event) => this.#interaction.notify(event),
    };
  }
}

function trackProvider(
  provider: Provider,
  activity: ResourceActivityTracker,
): Provider {
  return {
    id: provider.id,
    listModels: () => provider.listModels(),
    async *stream(model, context, options) {
      const release = activity.beginInference();
      try {
        yield* provider.stream(model, context, options);
      } finally {
        release();
      }
    },
  };
}

function lastAssistantText(context: Context): string {
  for (let index = context.messages.length - 1; index >= 0; index -= 1) {
    const message = context.messages[index];
    if (message?.role !== 'assistant') continue;
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }
  return '';
}

function isLocalProvider(provider: string): boolean {
  return provider === 'custom' || provider === 'lmstudio' || provider === 'llamacpp';
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  return new DefaultAgentSession(options);
}
