import type { Span, SpanExporter } from '../types.js';

export interface ConsoleSpanExporterOptions {
  write?: (text: string) => void;
}

/** flush 时按 parentSpanId 重建树，避免子 span 先结束导致缩进错误。 */
export class ConsoleSpanExporter implements SpanExporter {
  readonly #write: (text: string) => void;
  readonly #pending: Span[] = [];

  constructor(options: ConsoleSpanExporterOptions = {}) {
    this.#write = options.write ?? ((text) => process.stderr.write(text));
  }

  export(span: Span): void {
    this.#pending.push(structuredClone(span));
  }

  async flush(): Promise<void> {
    if (this.#pending.length === 0) return;
    const spans = this.#pending.splice(0);
    const ids = new Set(spans.map((span) => span.spanId));
    const children = new Map<string, Span[]>();
    const roots: Span[] = [];
    for (const span of spans) {
      if (span.parentSpanId === undefined || !ids.has(span.parentSpanId)) {
        roots.push(span);
        continue;
      }
      const siblings = children.get(span.parentSpanId) ?? [];
      siblings.push(span);
      children.set(span.parentSpanId, siblings);
    }
    const lines: string[] = [];
    for (const root of sorted(roots)) renderTree(root, children, 0, lines);
    this.#write(`${lines.join('\n')}\n`);
  }
}

function renderTree(
  span: Span,
  children: ReadonlyMap<string, Span[]>,
  depth: number,
  lines: string[],
): void {
  const duration = Math.max(0, span.endMs - span.startMs);
  const attrs = Object.keys(span.attrs).length === 0
    ? ''
    : ` ${JSON.stringify(span.attrs)}`;
  const error = span.error === undefined ? '' : ` error=${JSON.stringify(span.error)}`;
  lines.push(`${'  '.repeat(depth)}[span] ${span.name} ${duration}ms${attrs}${error}`);
  for (const child of sorted(children.get(span.spanId) ?? [])) {
    renderTree(child, children, depth + 1, lines);
  }
}

function sorted(spans: readonly Span[]): Span[] {
  return [...spans].sort(
    (left, right) => left.startMs - right.startMs || left.name.localeCompare(right.name),
  );
}
