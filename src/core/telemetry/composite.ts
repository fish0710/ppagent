import type { Span, SpanExporter } from '../types.js';

/** 同一 span 扇出到多个旁路；一个 exporter 故障不妨碍其余 exporter。 */
export class CompositeSpanExporter implements SpanExporter {
  readonly #exporters: readonly SpanExporter[];

  constructor(exporters: readonly SpanExporter[]) {
    if (exporters.length === 0) throw new Error('Composite exporter must not be empty');
    this.#exporters = [...exporters];
  }

  export(span: Span): void {
    for (const exporter of this.#exporters) {
      try {
        exporter.export(span);
      } catch {
        // 继续扇出；SpanRecorder 只能保护 composite 的外层调用。
      }
    }
  }

  async flush(): Promise<void> {
    const results = await Promise.allSettled(
      this.#exporters.map((exporter) => exporter.flush()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) throw new AggregateError(failures, 'Span exporters failed');
  }
}
