import type { AgentConfig } from './config/index.js';
import { StubAdmissionController } from './admission/index.js';
import { InteractivePermissionPolicy } from './permissions/index.js';
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
import {
  createTraceContext,
  flushSpanExporter,
} from '../core/telemetry/index.js';
import { createBuiltinToolRegistry } from '../core/tools/builtin/index.js';
import type {
  AdmissionController,
  Context,
  Interaction,
  Message,
  ModelRef,
  PermissionPolicy,
  Provider,
  ReadonlyContext,
  Sandbox,
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
  readonly #admission: AdmissionController;
  readonly #permissions: PermissionPolicy;
  readonly #sandbox: Sandbox;
  readonly #now: () => number;
  readonly #traceFactory: () => TraceContext;
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
    this.#registry = options.registry ?? createBuiltinToolRegistry();
    this.#admission = options.admission ?? new StubAdmissionController();
    this.#permissions = options.permissions ?? new InteractivePermissionPolicy();
    this.#sandbox = options.sandbox ?? new PassthroughSandbox();
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

      const tokenCounter = new O200kTokenCounter();
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
        provider: this.#options.provider,
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
          admission: this.#admission,
          permissions: this.#observablePermissions(),
          sandbox: this.#sandbox,
        },
        toolOptions: {
          maxResultChars: config.tools.maxResultChars,
          toolTimeoutMs: config.tools.toolTimeoutMs,
        },
        loopConfig: config.loop,
        maxToolConcurrency: config.tools.maxConcurrency,
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
      await flushSpanExporter(this.#options.telemetry?.exporter);
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

  #interactionProxy(): Interaction {
    return {
      confirm: (request) => this.#interaction.confirm(request),
      ask: (request) => this.#interaction.ask(request),
      select: (request) => this.#interaction.select(request),
      notify: (event) => this.#interaction.notify(event),
    };
  }
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  return new DefaultAgentSession(options);
}
