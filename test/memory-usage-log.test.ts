import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlMemoryUsageLog, type MemoryUsageLogEntry } from '../src/agent/memory/usage-log.js';

describe('MemoryUsageLog', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  async function newRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ppagent-usage-log-'));
    roots.push(root);
    return root;
  }

  it('returns an empty array before anything has been appended (no file yet)', async () => {
    const log = new JsonlMemoryUsageLog({ rootDirectory: await newRoot() });
    expect(await log.readAll()).toEqual([]);
  });

  it('appends one JSON line per entry, in order, and reads them back', async () => {
    const root = await newRoot();
    const log = new JsonlMemoryUsageLog({ rootDirectory: root });
    await log.append(entry({ sessionId: 's1', injectedIds: ['m1'], adoptedIds: ['m1'] }));
    await log.append(entry({ sessionId: 's2', injectedIds: ['m1', 'm2'], adoptedIds: [] }));

    const all = await log.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ sessionId: 's1', adoptedIds: ['m1'] });
    expect(all[1]).toMatchObject({ sessionId: 's2', adoptedIds: [] });
  });

  it('persists across separate MemoryUsageLog instances pointed at the same directory', async () => {
    const root = await newRoot();
    await new JsonlMemoryUsageLog({ rootDirectory: root }).append(entry({ sessionId: 'persisted' }));
    const reopened = new JsonlMemoryUsageLog({ rootDirectory: root });
    expect(await reopened.readAll()).toEqual([expect.objectContaining({ sessionId: 'persisted' })]);
  });
});

function entry(overrides: Partial<MemoryUsageLogEntry> = {}): MemoryUsageLogEntry {
  return {
    timestamp: 0,
    sessionId: 'session-1',
    injectedIds: [],
    adoptedIds: [],
    loopEndReason: 'stop',
    turns: 1,
    ...overrides,
  };
}
