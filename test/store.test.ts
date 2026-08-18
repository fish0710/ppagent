import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlStore } from '../src/core/store/jsonl.js';
import { latestCompaction, replay } from '../src/core/store/replay.js';
import { CompactionSequenceTracker } from '../src/core/store/sequence.js';
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
      'step four',
    ]);
    // 'step three' 的 seq 比 compaction 记录小 —— 它是压缩发生前就写盘的保留
    // 消息。按记录位置切会把它丢掉，必须按 firstKeptSeq 切。
    expect(replay(records, 'compacted').map(messageText)).toEqual([
      'cumulative summary through step two',
      'step three',
      'step four',
    ]);
    expect(latestCompaction(records)?.seq).toBe(6);
    expect(records).toEqual(original);
  });

  it('replays exactly what stayed in memory after compaction', () => {
    // 这是修复前会静默出错的场景：保持会话看得到最近几轮，--resume 却丢了。
    const messages = Array.from({ length: 5 }, (_, index) =>
      user(`m${index + 1}`, index + 1),
    );
    const records: StoreRecord[] = [];
    const tracker = CompactionSequenceTracker.empty();
    let seq = 1;
    const write = (message: Message): void => {
      records.push({ kind: 'message', seq, message });
      tracker.recordMessage(seq);
      seq += 1;
    };
    for (const message of messages) write(message);

    // 第一次压缩：视图 [m1..m5]，切点 3 → 保留 [m4, m5]。
    const firstSummary = user('summary #1', 100);
    records.push({
      kind: 'compaction',
      seq: seq++,
      summary: firstSummary,
      firstKeptSeq: tracker.compact(3).firstKeptSeq,
      trigger: 'token',
      replacedCount: 3,
      tokensBefore: 100,
      tokensAfter: 30,
      meta: summaryMeta(),
      timestamp: 100,
    });
    let view: Message[] = [firstSummary, ...messages.slice(3)];
    expect(replay(records, 'compacted')).toEqual(view);

    // 追加一条，再压一次：视图 [summary, m4, m5, m6]，切点 2 → 保留 [m5, m6]。
    const sixth = user('m6', 6);
    write(sixth);
    view = [...view, sixth];
    const secondSummary = user('summary #2', 200);
    records.push({
      kind: 'compaction',
      seq: seq++,
      summary: secondSummary,
      firstKeptSeq: tracker.compact(2).firstKeptSeq,
      trigger: 'token',
      replacedCount: 2,
      tokensBefore: 80,
      tokensAfter: 25,
      meta: summaryMeta(),
      timestamp: 200,
    });
    view = [secondSummary, ...view.slice(2)];

    expect(replay(records, 'compacted')).toEqual(view);
    expect(view.map(messageText)).toEqual(['summary #2', 'm5', 'm6']);
  });

  it('restores the sequence accounting across a resume', () => {
    const messages = Array.from({ length: 4 }, (_, index) =>
      user(`m${index + 1}`, index + 1),
    );
    const records: StoreRecord[] = messages.map((message, index) => ({
      kind: 'message' as const,
      seq: index + 1,
      message,
    }));
    const summary = user('summary #1', 100);
    records.push({
      kind: 'compaction',
      seq: 5,
      summary,
      firstKeptSeq: 3,
      trigger: 'token',
      replacedCount: 2,
      tokensBefore: 100,
      tokensAfter: 30,
      meta: summaryMeta(),
      timestamp: 100,
    });

    // 恢复出的视图是 [summary, m3, m4]；再追加一条后视图是 [summary, m3, m4, m5]。
    const restored = CompactionSequenceTracker.fromRecords(records);
    expect(replay(records, 'compacted')).toEqual([summary, messages[2], messages[3]]);
    restored.recordMessage(6);
    // 切点 2 对应视图下标 2，也就是 m4，其 seq 为 4。
    expect(restored.compact(2).firstKeptSeq).toBe(4);
  });

  it('tracks kept-user seqs across two compactions, surviving a resume in between', () => {
    // user 消息不折叠：折叠区里挑出来的 user 消息保留在视图下标 [1, headSize)，
    // 与"切点之后的连续尾巴"是两段不相邻的区间。tracker 的镜像必须能正确
    // 换算这两段各自的 seq，且在 --resume 之后（从磁盘重建镜像）依然正确。
    const messages = Array.from({ length: 6 }, (_, index) =>
      user(`m${index + 1}`, index + 1),
    );
    const records: StoreRecord[] = [];
    const tracker = CompactionSequenceTracker.empty();
    let seq = 1;
    const write = (message: Message): void => {
      records.push({ kind: 'message', seq, message });
      tracker.recordMessage(seq);
      seq += 1;
    };
    for (const message of messages) write(message);

    // 视图 [m1..m6]，切点 4（保留 [m5,m6]），折叠区里 m2 被选中保留。
    const firstSummary = user('summary #1', 100);
    const first = tracker.compact(4, [1]);
    expect(first.keptUserSeqs).toEqual([2]);
    records.push({
      kind: 'compaction',
      seq: seq++,
      summary: firstSummary,
      firstKeptSeq: first.firstKeptSeq,
      keptUserSeqs: first.keptUserSeqs,
      trigger: 'token',
      replacedCount: 4,
      tokensBefore: 100,
      tokensAfter: 30,
      meta: summaryMeta(),
      timestamp: 100,
    });
    // 视图现在是 [summary, m2, m5, m6]。
    expect(replay(records, 'compacted')).toEqual([firstSummary, messages[1], messages[4], messages[5]]);

    // 模拟 --resume：从磁盘重建 tracker，而不是复用内存里的实例。
    const resumed = CompactionSequenceTracker.fromRecords(records);
    const seventh = user('m7', 7);
    records.push({ kind: 'message', seq, message: seventh });
    resumed.recordMessage(seq);
    seq += 1;

    // 视图 [summary, m2, m5, m6, m7]，切点 3（保留 [m6,m7]）。keptUserIndices
    // 传的是这一轮结束后应该继续存活的 carried 全集在"当前视图"里的下标——
    // 既包含上一轮就保留的 m2（视图下标 1，budget 没把它挤掉），也包含这一轮
    // 新折叠进来又被选中保留的 m5（视图下标 2）——不是只传"新增"的那部分。
    const secondSummary = user('summary #2', 200);
    const second = resumed.compact(3, [1, 2]);
    expect(second.keptUserSeqs).toEqual([2, 5]); // 旧的 m2(seq2) + 新保留的 m5(seq5)
    records.push({
      kind: 'compaction',
      seq: seq++,
      summary: secondSummary,
      firstKeptSeq: second.firstKeptSeq,
      keptUserSeqs: second.keptUserSeqs,
      trigger: 'token',
      replacedCount: 3,
      tokensBefore: 80,
      tokensAfter: 25,
      meta: summaryMeta(),
      timestamp: 200,
    });

    expect(replay(records, 'compacted')).toEqual([
      secondSummary,
      messages[1], // m2
      messages[4], // m5
      messages[5], // m6
      seventh,
    ]);
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

/**
 * 顺序刻意打乱以验证 replay 自己排序，但 seq 的分配反映真实写入顺序：
 * 保留消息先落盘，compaction 记录后追加，所以保留消息的 seq 比它小。
 */
function replayFixture(): StoreRecord[] {
  return [
    { kind: 'message', seq: 4, message: user('step two', 4) },
    { kind: 'message', seq: 1, message: user('task', 1) },
    {
      kind: 'compaction',
      seq: 3,
      summary: user('summary through step one', 3),
      firstKeptSeq: 2,
      trigger: 'token',
      replacedCount: 1,
      tokensBefore: 100,
      tokensAfter: 30,
      meta: summaryMeta(),
      timestamp: 3,
    },
    { kind: 'message', seq: 2, message: user('step one', 2) },
    { kind: 'message', seq: 5, message: user('step three', 5) },
    {
      kind: 'compaction',
      seq: 6,
      summary: user('cumulative summary through step two', 6),
      firstKeptSeq: 5,
      trigger: 'token',
      replacedCount: 2,
      tokensBefore: 80,
      tokensAfter: 25,
      meta: summaryMeta(),
      timestamp: 6,
    },
    { kind: 'message', seq: 7, message: user('step four', 7) },
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
