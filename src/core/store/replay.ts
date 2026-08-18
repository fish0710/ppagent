import type { Message, StoreRecord } from '../types.js';

export type ReplayProjection = 'compacted' | 'full';

/**
 * append-only 记录到内存消息的纯投影：不读文件、不改输入，也不依赖 Store。
 */
export function replay(
  records: readonly StoreRecord[],
  projection: ReplayProjection = 'compacted',
): Message[] {
  const ordered = [...records].sort((left, right) => left.seq - right.seq);
  assertUniqueSequences(ordered);
  if (projection === 'full') {
    return structuredClone(
      ordered
        .filter(
          (record): record is Extract<StoreRecord, { kind: 'message' }> =>
            record.kind === 'message',
        )
        .map((record) => record.message),
    );
  }

  // 必须从后向前找最后一条覆盖式 compaction；正向扫描会先保留已被替换记录。
  let compactIndex = -1;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    if (ordered[index]?.kind === 'compaction') {
      compactIndex = index;
      break;
    }
  }
  if (compactIndex === -1) return replay(ordered, 'full');
  const compact = ordered[compactIndex];
  if (compact?.kind !== 'compaction') return [];
  // 按 firstKeptSeq 切，不能按记录位置切。compaction 记录是在保留消息都写盘
  // 之后才追加的，那批保留消息的 seq 比它小 —— 按位置切会把压缩后仍在内存
  // 视图里的最近几轮原文全部丢掉，而且不报错。
  //
  // keptUserSeqs 是折叠区里原样保留的 user 消息（user 消息不折叠策略），全部
  // 小于 firstKeptSeq——它们来自被摘要取代的那段历史，只是没有被折叠。按 seq
  // 排序后天然排在 firstKeptSeq 之后的原文之前，不需要额外的归并逻辑。老记录
  // 没有这个字段时按空数组处理，行为等同于没有保留过 user 消息。
  const keptUserSeqs = new Set(compact.keptUserSeqs ?? []);
  const kept = ordered
    .filter(
      (record): record is Extract<StoreRecord, { kind: 'message' }> =>
        record.kind === 'message' &&
        (keptUserSeqs.has(record.seq) || record.seq >= compact.firstKeptSeq),
    )
    .map((record) => record.message);
  return structuredClone([compact.summary, ...kept]);
}

export function latestCompaction(
  records: readonly StoreRecord[],
): Extract<StoreRecord, { kind: 'compaction' }> | undefined {
  return [...records]
    .sort((left, right) => right.seq - left.seq)
    .find(
      (record): record is Extract<StoreRecord, { kind: 'compaction' }> =>
        record.kind === 'compaction',
    );
}

function assertUniqueSequences(records: readonly StoreRecord[]): void {
  for (let index = 1; index < records.length; index += 1) {
    if (records[index - 1]?.seq === records[index]?.seq) {
      throw new Error(`Duplicate store sequence: ${records[index]?.seq}`);
    }
  }
}
