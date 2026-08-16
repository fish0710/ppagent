import type { AgentConfig } from './config/index.js';
import { ResourceAdmissionController } from './admission/index.js';
import { InteractivePermissionPolicy } from './permissions/index.js';
import {
  createSpawnSubagentTool,
  type SpawnSubagentRunner,
} from './tools/spawn-subagent.js';
import { StructuralSummarizer } from '../core/context/compact.js';
import { ThresholdCompactPolicy } from '../core/context/compact.js';
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
  Context,
  Interaction,
  Message,
  ModelRef,
  PermissionPolicy,
  Provider,
  ReadonlyContext,
  ResourceProbe,
  Sandbox,
  TokenCounter,
  ToolContext,
  TraceContext,
  UIEvent,
} from '../core/types.js';
import { ToolRegistry } from '../core/tools/registry.js';

export interface AgentSession {
  prompt(text: string): Promise<AgentLoopResult>;
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
  #interaction: Interaction;
  #controller: AbortController | undefined;

  constructor(options: AgentSessionOptions) {
    this.#options = options;
    this.#context = structuredClone(options.context ?? { messages: [] });
    this.#previousSummary =
      options.previousSummary === undefined
        ? undefined
        : structuredClone(options.previousSummary);
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
      ]);
    this.#now = options.now ?? Date.now;
    this.#traceFactory = options.traceFactory ?? createTraceContext;
  }

  get context(): ReadonlyContext {
    return this.#context;
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
      const persistence: AgentLoopPersistence = {
        appendMessages: async (messages) =>
          this.#options.persistence?.appendMessages(messages),
        appendCompaction: async (result) => {
          this.#previousSummary = structuredClone(result.summary);
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
        ...(config.provider.maxOutputTokens === undefined &&
        config.provider.effort === undefined
          ? {}
          : {
              streamOptions: {
                ...(config.provider.maxOutputTokens === undefined
                  ? {}
                  : { maxTokens: config.provider.maxOutputTokens }),
                ...(config.provider.effort === undefined
                  ? {}
                  : { effort: config.provider.effort }),
              },
            }),
        compaction: {
          tokenCounter,
          policy: new ThresholdCompactPolicy({
            config: config.context,
            tokenCounter,
          }),
          summarizer: new StructuralSummarizer({ tokenCounter }),
          contextWindow:
            config.context.contextWindow ?? this.#options.model.contextWindow,
          targetTokens: Math.max(
            1,
            Math.floor(
              (config.context.contextWindow ?? this.#options.model.contextWindow) *
                config.context.summaryTargetRatio,
            ),
          ),
          ...(this.#previousSummary === undefined
            ? {}
            : { previousSummary: this.#previousSummary }),
          resourceProbe: this.#resourceProbe,
        },
        persistence,
        ...(this.#options.telemetry === undefined
          ? {}
          : { telemetry: this.#options.telemetry }),
        emit: (event) => this.#emit(event),
      });
      this.#context = result.context;
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
