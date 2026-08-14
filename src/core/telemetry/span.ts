import { randomUUID } from 'node:crypto';
import type {
  Span,
  SpanExporter,
  TraceContext,
} from '../types.js';

export type SpanAttributes = Span['attrs'];

export interface TraceContextOptions {
  traceId?: string;
  spanId?: string;
  idFactory?: () => string;
}

/** 创建真正维护 parentSpanId 的 trace；child 的 name 只用于可读 spanId 前缀。 */
export function createTraceContext(
  options: TraceContextOptions = {},
): TraceContext {
  const idFactory = options.idFactory ?? randomUUID;
  const traceId = options.traceId ?? idFactory();
  return traceContext(
    traceId,
    options.spanId ?? idFactory(),
    undefined,
    idFactory,
  );
}

export interface ActiveSpan {
  readonly context: TraceContext;
  setAttribute(key: string, value: string | number | boolean): void;
  end(attrs?: SpanAttributes, error?: unknown): void;
}

export interface SpanRecorderOptions {
  now?: () => number;
}

/**
 * 极小的 span 生命周期实现。exporter 故障不能反向打断 agent 主流程；网络型
 * exporter 的批量发送与重试由其 flush 实现负责。
 */
export class SpanRecorder {
  readonly #exporter: SpanExporter;
  readonly #now: () => number;

  constructor(exporter: SpanExporter, options: SpanRecorderOptions = {}) {
    this.#exporter = exporter;
    this.#now = options.now ?? Date.now;
  }

  start(
    name: string,
    context: TraceContext,
    attrs: SpanAttributes = {},
  ): ActiveSpan {
    if (name.trim().length === 0) throw new Error('Span name must not be empty');
    const startedAt = this.#now();
    const accumulated: SpanAttributes = { ...attrs };
    let ended = false;
    return {
      context,
      setAttribute(key, value) {
        if (!ended) accumulated[key] = value;
      },
      end: (finalAttrs = {}, error?: unknown) => {
        if (ended) return;
        ended = true;
        const endedAt = this.#now();
        const span: Span = {
          name,
          traceId: context.traceId,
          spanId: context.spanId,
          ...(context.parentSpanId === undefined
            ? {}
            : { parentSpanId: context.parentSpanId }),
          startMs: startedAt,
          endMs: Math.max(startedAt, endedAt),
          attrs: { ...accumulated, ...finalAttrs },
          ...(error === undefined ? {} : { error: errorMessage(error) }),
        };
        try {
          this.#exporter.export(span);
        } catch {
          // 遥测是旁路；exporter 不得改变任务成功、失败或取消语义。
        }
      },
    };
  }
}

function traceContext(
  traceId: string,
  spanId: string,
  parentSpanId: string | undefined,
  idFactory: () => string,
): TraceContext {
  return {
    traceId,
    spanId,
    ...(parentSpanId === undefined ? {} : { parentSpanId }),
    child(name) {
      const prefix = name.trim().replace(/[^a-zA-Z0-9_.:-]+/gu, '-');
      return traceContext(
        traceId,
        `${prefix || 'span'}-${idFactory()}`,
        spanId,
        idFactory,
      );
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
