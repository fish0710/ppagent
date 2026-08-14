import type { Span, SpanExporter } from '../types.js';

/** 测试与嵌入方使用的确定性收集器。 */
export class InMemorySpanExporter implements SpanExporter {
  readonly #spans: Span[] = [];

  export(span: Span): void {
    this.#spans.push(structuredClone(span));
  }

  get spans(): readonly Span[] {
    return structuredClone(this.#spans);
  }

  async flush(): Promise<void> {
    // 内存写入在 export 时已经完成。
  }
}
