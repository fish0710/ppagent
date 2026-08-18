import type { StoreRecord } from '../types.js';

export interface CompactionSequenceResult {
  firstKeptSeq: number;
  /** 折叠区里原样保留的 user 消息的 seq，从旧到新排列。 */
  keptUserSeqs: number[];
}

/**
 * 把内存视图里的下标翻译成磁盘上的 seq，供 compaction 记录写
 * firstKeptSeq/keptUserSeqs。
 *
 * 为什么需要它：CompactResult.replacedCount/keptUserIndices 都是**内存视图**
 * 的下标，而内存视图首条可能是上一次的摘要（磁盘上没有对应的 message 记录），
 * 保留区也不再是单一连续段——user 消息不折叠之后，保留区是"折叠区里挑出来的
 * 若干条 user 消息"加上"切点之后的连续尾巴"两段拼起来的。直接拿下标当 seq
 * 用会静默错位；这个类维护一份"视图下标 → seq"的镜像，任何下标都能查到
 * 它对应的磁盘位置。
 *
 * 记账放在唯一分配 seq 的地方 —— 持久化回调本身。loop 与 ContextManager 都
 * 不认识 seq，也不该为了这件事认识。
 */
export class CompactionSequenceTracker {
  /**
   * 镜像当前内存视图（context.messages）：#viewSeqs[i] 是视图第 i 条消息在
   * 磁盘上的 seq，summary 槽位（存在摘要时的第 0 位）没有对应的 message
   * 记录，用 null 占位。
   */
  #viewSeqs: (number | null)[];

  private constructor(viewSeqs: (number | null)[]) {
    this.#viewSeqs = viewSeqs;
  }

  /** 新会话。 */
  static empty(): CompactionSequenceTracker {
    return new CompactionSequenceTracker([]);
  }

  /**
   * --resume 用：从已有记录还原记账状态，与 replay(records, 'compacted')
   * 产生的内存视图对齐——两者都是"summary + keptUserSeqs（按 seq 排序）+
   * seq >= firstKeptSeq 的 message（按 seq 排序）"。
   */
  static fromRecords(
    records: readonly StoreRecord[],
  ): CompactionSequenceTracker {
    const ordered = [...records].sort((left, right) => left.seq - right.seq);
    const messageSeqs = ordered
      .filter((record) => record.kind === 'message')
      .map((record) => record.seq);
    let last: Extract<StoreRecord, { kind: 'compaction' }> | undefined;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const record = ordered[index];
      if (record?.kind === 'compaction') {
        last = record;
        break;
      }
    }
    if (last === undefined) return new CompactionSequenceTracker(messageSeqs);
    // keptUserSeqs 全部小于 firstKeptSeq（来自被摘要取代的那段历史），两组
    // 各自已经按 seq 单调递增，拼接顺序就是正确的排序结果，不需要归并。
    const keptUserSeqs = last.keptUserSeqs ?? [];
    const tailSeqs = messageSeqs.filter((seq) => seq >= last!.firstKeptSeq);
    return new CompactionSequenceTracker([null, ...keptUserSeqs, ...tailSeqs]);
  }

  /** 每写一条 message 记录调用一次，顺序必须与写入顺序（视图追加顺序）一致。 */
  recordMessage(seq: number): void {
    this.#viewSeqs.push(seq);
  }

  /**
   * 由内存视图的切点下标、保留 user 消息下标求 firstKeptSeq/keptUserSeqs，
   * 并把内部状态推进成"压缩之后的新视图"。只在 kind === 'summarize' 的压缩
   * 上调用；keptUserIndices 省略时按没有保留 user 消息处理。
   */
  compact(
    replacedCount: number,
    keptUserIndices: readonly number[] = [],
  ): CompactionSequenceResult {
    const firstKeptSeq = this.#viewSeqs[replacedCount];
    if (firstKeptSeq === undefined || firstKeptSeq === null) {
      throw new Error(
        `Compaction cut ${replacedCount} does not map to a persisted message`,
      );
    }
    const keptUserSeqs = keptUserIndices.map((index) => {
      const seq = this.#viewSeqs[index];
      if (seq === undefined || seq === null) {
        throw new Error(
          `Kept-user index ${index} does not map to a persisted message`,
        );
      }
      return seq;
    });
    const tailSeqs = this.#viewSeqs
      .slice(replacedCount)
      .filter((seq): seq is number => seq !== null);
    this.#viewSeqs = [null, ...keptUserSeqs, ...tailSeqs];
    return { firstKeptSeq, keptUserSeqs };
  }
}
