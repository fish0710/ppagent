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
  const trailing = ordered
    .slice(compactIndex + 1)
    .filter(
      (record): record is Extract<StoreRecord, { kind: 'message' }> =>
        record.kind === 'message',
    )
    .map((record) => record.message);
  return structuredClone([compact.summary, ...trailing]);
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
