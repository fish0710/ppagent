import { describe, expect, it } from 'vitest';
import { createMemorySearchTool } from '../src/agent/tools/memory-search.js';
import { writeMemoryRecord, type MemoryStores } from '../src/agent/memory/index.js';
import type { MemoryRecord, ToolOutput } from '../src/core/types.js';

describe('createMemorySearchTool', () => {
  it('exposes a stable tool definition: named, single required string query, concurrency-safe, non-privileged', () => {
    const tool = createMemorySearchTool({ stores: stores(), projectKey: 'proj' });
    expect(tool.name).toBe('memory_search');
    expect(tool.concurrencySafe).toBe(true);
    expect(tool.privileged).toBeUndefined();
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      additionalProperties: false,
    });
  });

  it('returns matching memories from both project and user scope, formatted with their kind', async () => {
    const memoryStores = stores();
    await writeMemoryRecord(
      memoryStores,
      record({ id: 'p1', scope: 'project', kind: 'pitfall', text: 'npm run verify catches this' }),
    );
    await writeMemoryRecord(
      memoryStores,
      record({ id: 'u1', scope: 'user', kind: 'convention', text: 'npm run verify before commit' }),
    );
    const tool = createMemorySearchTool({ stores: memoryStores, projectKey: 'proj' });

    const output = await tool.execute({ query: 'npm run verify' }, fakeContext());

    const text = firstText(output);
    expect(text).toContain('[pitfall] npm run verify catches this');
    expect(text).toContain('[convention] npm run verify before commit');
    expect(output.isError).toBe(false);
  });

  it('excludes project-scope memories from a different project', async () => {
    const memoryStores = stores();
    await writeMemoryRecord(
      memoryStores,
      record({ id: 'other', scope: 'project', projectKey: 'other-proj', text: 'npm run verify' }),
    );
    const tool = createMemorySearchTool({ stores: memoryStores, projectKey: 'proj' });

    const output = await tool.execute({ query: 'npm run verify' }, fakeContext());
    expect(firstText(output)).toBe('No matching memories found.');
  });

  it('reports no matches without erroring when the store is empty', async () => {
    const tool = createMemorySearchTool({ stores: stores(), projectKey: 'proj' });
    const output = await tool.execute({ query: 'anything' }, fakeContext());
    expect(output.isError).toBe(false);
    expect(firstText(output)).toBe('No matching memories found.');
  });

  it('throws on an empty query, letting the tool-execution chain turn it into a retryable tool error', async () => {
    const tool = createMemorySearchTool({ stores: stores(), projectKey: 'proj' });
    await expect(tool.execute({ query: '   ' }, fakeContext())).rejects.toThrow(
      'Search query must not be empty',
    );
  });

  it('is more permissive than eager retrieval by default: minScore 0 and larger slots, so a lazy search still surfaces weak matches', async () => {
    const memoryStores = stores();
    await writeMemoryRecord(
      memoryStores,
      record({ id: 'weak', text: 'a barely related note about npm' }),
    );
    const tool = createMemorySearchTool({ stores: memoryStores, projectKey: 'proj' });
    const output = await tool.execute({ query: 'npm scripts and tooling' }, fakeContext());
    expect(firstText(output)).not.toBe('No matching memories found.');
  });
});

function stores(): MemoryStores {
  return { project: new InMemoryStore(), user: new InMemoryStore() };
}

class InMemoryStore {
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

function firstText(output: ToolOutput): string {
  const block = output.content[0];
  return block?.type === 'text' ? block.text : '';
}

function fakeContext() {
  return {
    signal: new AbortController().signal,
    cwd: process.cwd(),
    trace: { traceId: 't', spanId: 's', child: () => fakeContext().trace },
    interaction: {
      confirm: async () => false,
      ask: async () => null,
      select: async () => null,
      notify: () => undefined,
    },
  };
}
