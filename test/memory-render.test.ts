import { describe, expect, it } from 'vitest';
import { renderMemoryBlock } from '../src/core/memory/render.js';
import { O200kTokenCounter } from '../src/core/context/tokenizer.js';
import type { MemoryRecord } from '../src/core/types.js';

const counter = new O200kTokenCounter();

describe('renderMemoryBlock', () => {
  it('returns an empty string and no included records for an empty input', () => {
    expect(renderMemoryBlock([], counter, 1000)).toEqual({ text: '', included: [] });
  });

  it('wraps selected records in a delimited block with kind labels, and reports them all included', () => {
    const record1 = record({ id: 'm1', kind: 'pitfall', text: 'bash tool must spawn detached' });
    const { text, included } = renderMemoryBlock([record1], counter, 1000);
    expect(text).toContain('<long-term-memory>');
    expect(text).toContain('</long-term-memory>');
    expect(text).toContain('[pitfall] bash tool must spawn detached');
    expect(included).toEqual([record1]);
  });

  it('drops lowest-priority (tail) records first when over budget, not mid-text truncation', () => {
    const high = record({ id: 'high-priority', text: 'keep this one, it is first and highest priority' });
    const low = record({ id: 'low-priority', text: 'this one should be dropped when budget is tight' });
    const records = [high, low];
    const fullBudget = counter.countText(
      renderMemoryBlock(records, counter, Number.MAX_SAFE_INTEGER).text,
    );
    const tight = renderMemoryBlock(records, counter, fullBudget - 1);
    expect(tight.text).toContain('keep this one');
    expect(tight.text).not.toContain('should be dropped');
    expect(tight.included).toEqual([high]);
  });

  it('returns an empty string and no included records when even one record does not fit', () => {
    const huge = record({ id: 'huge', text: 'x'.repeat(10_000) });
    expect(renderMemoryBlock([huge], counter, 5)).toEqual({ text: '', included: [] });
  });

  it('never mid-truncates a single record — either the whole line fits or it is dropped', () => {
    const records = [record({ id: 'm1', text: 'a specific identifier: foo_bar_baz_qux' })];
    const { text } = renderMemoryBlock(records, counter, 1000);
    expect(text).toContain('foo_bar_baz_qux');
  });
});

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'm1',
    scope: 'project',
    kind: 'fact',
    text: 'placeholder',
    projectKey: 'proj',
    sourceSessionId: 'session-1',
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
