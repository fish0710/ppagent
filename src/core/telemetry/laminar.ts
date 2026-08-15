import { createHash } from 'node:crypto';
import type { Span, SpanExporter } from '../types.js';

export interface LaminarSpanExporterOptions {
  apiKey: string;
  endpoint?: string;
  serviceName?: string;
  serviceVersion?: string;
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Laminar 的 OTLP/HTTP JSON 批量 exporter；core 只消费显式构造参数。 */
export class LaminarSpanExporter implements SpanExporter {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #serviceName: string;
  readonly #serviceVersion: string | undefined;
  readonly #maxRetries: number;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #pending: Span[] = [];
  #flushing: Promise<void> | undefined;

  constructor(options: LaminarSpanExporterOptions) {
    this.#apiKey = options.apiKey.trim();
    if (this.#apiKey.length === 0) throw new Error('Laminar API key must not be empty');
    this.#endpoint = traceEndpoint(options.endpoint ?? 'https://api.lmnr.ai');
    this.#serviceName = options.serviceName?.trim() || 'ppagent';
    this.#serviceVersion = options.serviceVersion?.trim() || undefined;
    this.#maxRetries = options.maxRetries ?? 2;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.#maxRetries) || this.#maxRetries < 0) {
      throw new Error('Laminar maxRetries must be a non-negative integer');
    }
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error('Laminar timeoutMs must be a positive integer');
    }
    this.#fetch = options.fetch ?? fetch;
    this.#sleep = options.sleep ?? delay;
  }

  export(span: Span): void {
    this.#pending.push(structuredClone(span));
  }

  async flush(): Promise<void> {
    if (this.#flushing !== undefined) {
      await this.#flushing;
      // export() 可能在网络请求进行时又加入 span；当前批完成后继续排空。
      if (this.#pending.length > 0) await this.flush();
      return;
    }
    if (this.#pending.length === 0) return;
    const operation = this.#drain();
    this.#flushing = operation;
    try {
      await operation;
    } finally {
      if (this.#flushing === operation) this.#flushing = undefined;
    }
  }

  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const batch = this.#pending.splice(0);
      try {
        await this.#send(batch);
      } catch (error) {
        // 保留未送达批次，让下次 prompt/进程收尾仍有机会重试。
        this.#pending.unshift(...batch);
        throw error;
      }
    }
  }

  async #send(spans: readonly Span[]): Promise<void> {
    const body = JSON.stringify(
      otlpTraceRequest(spans, this.#serviceName, this.#serviceVersion),
    );
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('Laminar export timed out')),
        this.#timeoutMs,
      );
      timer.unref();
      try {
        const response = await this.#fetch(this.#endpoint, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.#apiKey}`,
            'content-type': 'application/json',
          },
          body,
          signal: controller.signal,
        });
        if (response.ok) return;
        const detail = (await response.text()).slice(0, 1_000);
        const error = new Error(
          `Laminar OTLP export failed with HTTP ${response.status}${
            detail.length === 0 ? '' : `: ${detail}`
          }`,
        );
        if (!retryableStatus(response.status)) {
          throw new PermanentLaminarExportError(error.message);
        }
        lastError = error;
      } catch (error) {
        if (error instanceof PermanentLaminarExportError) throw error;
        lastError = error;
        if (attempt >= this.#maxRetries) break;
      } finally {
        clearTimeout(timer);
      }
      await this.#sleep(100 * 2 ** attempt);
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Laminar OTLP export failed: ${String(lastError)}`);
  }
}

class PermanentLaminarExportError extends Error {
  override readonly name = 'PermanentLaminarExportError';
}

export function otlpTraceRequest(
  spans: readonly Span[],
  serviceName = 'ppagent',
  serviceVersion?: string,
): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            otlpAttribute('service.name', serviceName),
            ...(serviceVersion === undefined
              ? []
              : [otlpAttribute('service.version', serviceVersion)]),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'ppagent', version: serviceVersion ?? '' },
            spans: spans.map(otlpSpan),
          },
        ],
      },
    ],
  };
}

function otlpSpan(span: Span): unknown {
  const semantic = semanticAttributes(span);
  return {
    traceId: otlpId(span.traceId, 32),
    spanId: otlpId(span.spanId, 16),
    ...(span.parentSpanId === undefined
      ? {}
      : { parentSpanId: otlpId(span.parentSpanId, 16) }),
    name: span.name,
    kind: 1,
    startTimeUnixNano: String(Math.trunc(span.startMs * 1_000_000)),
    endTimeUnixNano: String(Math.trunc(span.endMs * 1_000_000)),
    attributes: Object.entries({ ...span.attrs, ...semantic }).map(([key, value]) =>
      otlpAttribute(key, value),
    ),
    status:
      span.error === undefined
        ? { code: 1 }
        : { code: 2, message: span.error },
  };
}

function semanticAttributes(span: Span): Span['attrs'] {
  const attrs: Span['attrs'] = {
    'lmnr.span.type': span.name === 'model.stream' ? 'LLM' : 'DEFAULT',
  };
  if (span.attrs['model.provider'] !== undefined) {
    attrs['gen_ai.system'] = span.attrs['model.provider'];
  }
  if (span.attrs['model.id'] !== undefined) {
    attrs['gen_ai.request.model'] = span.attrs['model.id'];
  }
  if (span.attrs['model.input_tokens'] !== undefined) {
    attrs['gen_ai.usage.input_tokens'] = span.attrs['model.input_tokens'];
  }
  if (span.attrs['model.output_tokens'] !== undefined) {
    attrs['gen_ai.usage.output_tokens'] = span.attrs['model.output_tokens'];
  }
  return attrs;
}

function otlpAttribute(
  key: string,
  value: string | number | boolean,
): { key: string; value: Record<string, string | number | boolean> } {
  if (typeof value === 'string') return { key, value: { stringValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return Number.isInteger(value)
    ? { key, value: { intValue: String(value) } }
    : { key, value: { doubleValue: value } };
}

function otlpId(value: string, length: 16 | 32): string {
  const compact = value.replaceAll('-', '').toLowerCase();
  if (new RegExp(`^[0-9a-f]{${length}}$`, 'u').test(compact)) return compact;
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function traceEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Laminar endpoint must use http or https');
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/u, '');
  if (!url.pathname.endsWith('/v1/traces')) {
    url.pathname = `${url.pathname}/v1/traces`.replace(/\/{2,}/gu, '/');
  }
  return url.toString();
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function delay(ms: number): Promise<void> {
  // flush 正在等待重试时必须保持事件循环存活，否则短命 CLI 会丢掉最后一批 span。
  return new Promise((resolve) => setTimeout(resolve, ms));
}
