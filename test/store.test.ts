import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlStore } from '../src/core/store/jsonl.js';
import { latestCompaction, replay } from '../src/core/store/replay.js';
import type { Message, StoreRecord } from '../src/core/types.js';

describe('store replay', () => {
  it('projects the latest compacted view and the complete debug history', () => {
    const records = replayFixture();
    const original = structuredClone(records);

    expect(replay(records, 'full').map(messageText)).toEqual([
      'task',
      'step one',
      'step two',
      'step three',
    ]);
    expect(replay(records, 'compacted').map(messageText)).toEqual([
      'cumulative summary through step two',
      'step three',
    ]);
    expect(latestCompaction(records)?.seq).toBe(6);
    expect(records).toEqual(original);
  });

  it('rejects duplicate sequence numbers instead of replaying ambiguously', () => {
    const records = replayFixture();
    records.push({ kind: 'message', seq: 4, message: user('duplicate', 9) });
    expect(() => replay(records)).toThrow('Duplicate store sequence: 4');
  });
});

describe('JSONL store', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it('appends records, restores them in sequence order, and lists metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ppagent-store-'));
    roots.push(root);
    let now = 100;
    const store = new JsonlStore({ rootDirectory: root, now: () => now++ });
    await store.create({ id: 'session/one', cwd: '/work', title: 'task' });

    const fixture = replayFixture();
    const records = [fixture[2]!, fixture[3]!, fixture[1]!];
    for (const record of records) await store.append('session/one', record);

    expect((await store.load('session/one')).map((record) => record.seq)).toEqual([
      1, 2, 3,
    ]);
    await store.touch('session/one', { model: 'custom/model' });
    expect(await store.list()).toMatchObject([
      { id: 'session/one', cwd: '/work', title: 'task', model: 'custom/model' },
    ]);

    const jsonl = await readFile(
      join(root, 'session-session%2Fone', 'records.jsonl'),
      'utf8',
    );
    expect(jsonl.trim().split('\n')).toHaveLength(3);
  });
});

function replayFixture(): StoreRecord[] {
  return [
    { kind: 'message', seq: 4, message: user('step two', 4) },
    { kind: 'message', seq: 1, message: user('task', 1) },
    {
      kind: 'compaction',
      seq: 3,
      summary: user('summary through step one', 3),
      trigger: 'token',
      replacedCount: 2,
      tokensBefore: 100,
      tokensAfter: 30,
      meta: summaryMeta(),
      timestamp: 3,
    },
    { kind: 'message', seq: 2, message: user('step one', 2) },
    { kind: 'message', seq: 7, message: user('step three', 7) },
    {
      kind: 'compaction',
      seq: 6,
      summary: user('cumulative summary through step two', 6),
      trigger: 'token',
      replacedCount: 2,
      tokensBefore: 80,
      tokensAfter: 25,
      meta: summaryMeta(),
      timestamp: 6,
    },
  ];
}

function user(content: string, timestamp: number) {
  return { role: 'user' as const, content, timestamp };
}

function messageText(message: Message): string {
  if (message.role === 'user' && typeof message.content === 'string') {
    return message.content;
  }
  return '';
}

function summaryMeta() {
  return {
    strategy: 'test',
    tokensIn: 10,
    tokensOut: 3,
    latencyMs: 0,
    modelCalls: 0,
  };
}
