import type { MemoryRecord } from '../types.js';

/**
 * 词法检索：BM25 + scope 精确过滤 + 槽位配额 + MMR 去重。纯函数，无 IO。
 *
 * 为什么不是向量检索：项目零 ML 依赖，错题本 11.2 已经因为评测冷启动代价
 * 否决过引入推理 runtime。v1 记忆量在数百条级别，词法检索够用；接口与实现
 * 分离（MemoryStore 只管存取），换成向量检索不需要动调用方。
 *
 * 老实说：首轮 query 信息量少 + 词法匹配，召回质量会一般。这是 v1 接受的
 * 代价，见落地计划第六节的验证方案。
 */

export interface MemoryQuery {
  /** 通常是首轮用户消息；急切检索（会话启动时）信息量天然比惰性检索少。 */
  text: string;
  /** project scope 记忆的精确过滤键；未命中的 project 记忆直接被排除，不降权。 */
  projectKey?: string;
}

export interface MemorySlots {
  project: number;
  user: number;
  /** 按曝光次数最低挑选，跳过 minScore 门槛，让新记忆有机会被验证。 */
  explore: number;
}

export interface MemoryRankOptions {
  slots: MemorySlots;
  /** 原始 BM25 分数阈值；槽内候选分数低于此值，该槽注入 0 条，不凑数。 */
  minScore: number;
}

const MMR_LAMBDA = 0.7;
const TOKEN_PATTERN = /[a-z0-9_./-]+/gu;

/**
 * 选中的记忆，按槽位内部优先级排好序 —— render.ts 在预算不够时从尾部丢弃，
 * 不需要重新排序。
 */
export function rankMemories(
  records: readonly MemoryRecord[],
  query: MemoryQuery,
  options: MemoryRankOptions,
): MemoryRecord[] {
  const active = records.filter((record) => record.status === 'active');
  const projectCandidates = active.filter(
    (record) => record.scope === 'project' && record.projectKey === query.projectKey,
  );
  const userCandidates = active.filter((record) => record.scope === 'user');

  const queryTokens = tokenize(query.text);
  const projectSelected = selectScoredSlot(
    projectCandidates,
    queryTokens,
    options.slots.project,
    options.minScore,
  );
  const userSelected = selectScoredSlot(
    userCandidates,
    queryTokens,
    options.slots.user,
    options.minScore,
  );

  const pickedIds = new Set([...projectSelected, ...userSelected].map((r) => r.id));
  const exploreSelected = selectExploreSlot(
    [...projectCandidates, ...userCandidates].filter((record) => !pickedIds.has(record.id)),
    options.slots.explore,
  );

  return [...projectSelected, ...userSelected, ...exploreSelected];
}

function selectScoredSlot(
  candidates: readonly MemoryRecord[],
  queryTokens: string[],
  slotSize: number,
  minScore: number,
): MemoryRecord[] {
  if (slotSize <= 0 || candidates.length === 0) return [];
  const docs = candidates.map((record) => tokenize(record.text));
  const scores = bm25Scores(queryTokens, docs);
  const scored = candidates
    .map((record, index) => ({ record, tokens: docs[index] ?? [], score: scores[index] ?? 0 }))
    .filter((entry) => entry.score >= minScore);
  if (scored.length === 0) return [];
  const maxScore = Math.max(...scored.map((entry) => entry.score));
  const normalized = scored.map((entry) => ({
    ...entry,
    normalizedScore: maxScore === 0 ? 0 : entry.score / maxScore,
  }));
  return mmrSelect(normalized, slotSize).map((entry) => entry.record);
}

/** 探索槽刻意不用相关性排序——它存在的目的就是绕开分数门槛给新记忆曝光机会。 */
function selectExploreSlot(
  candidates: readonly MemoryRecord[],
  slotSize: number,
): MemoryRecord[] {
  if (slotSize <= 0 || candidates.length === 0) return [];
  return [...candidates]
    .sort((a, b) => a.exposure - b.exposure || a.createdAt - b.createdAt)
    .slice(0, slotSize);
}

interface ScoredCandidate {
  record: MemoryRecord;
  tokens: string[];
  normalizedScore: number;
}

/** Maximal Marginal Relevance：兼顾相关性与去重，避免槽位被 3 条说同一件事的记忆占满。 */
function mmrSelect(candidates: ScoredCandidate[], count: number): ScoredCandidate[] {
  const pool = [...candidates].sort((a, b) => b.normalizedScore - a.normalizedScore);
  const selected: ScoredCandidate[] = [];
  while (selected.length < count && pool.length > 0) {
    let bestIndex = 0;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < pool.length; index += 1) {
      const candidate = pool[index]!;
      const maxSimilarity = selected.reduce(
        (max, picked) => Math.max(max, jaccard(candidate.tokens, picked.tokens)),
        0,
      );
      const value = MMR_LAMBDA * candidate.normalizedScore - (1 - MMR_LAMBDA) * maxSimilarity;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
      }
    }
    selected.push(pool.splice(bestIndex, 1)[0]!);
  }
  return selected;
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Okapi BM25，idf 在传入的候选集内部计算 —— 语料就是这次要排序的这批记忆。 */
function bm25Scores(query: readonly string[], docs: readonly string[][], k1 = 1.5, b = 0.75): number[] {
  const docCount = docs.length;
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docCount);
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = (term: string): number => {
    const n = documentFrequency.get(term) ?? 0;
    return Math.log(1 + (docCount - n + 0.5) / (n + 0.5));
  };
  return docs.map((doc) => {
    const termFrequency = new Map<string, number>();
    for (const term of doc) termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of query) {
      const frequency = termFrequency.get(term) ?? 0;
      if (frequency === 0) continue;
      const numerator = frequency * (k1 + 1);
      const denominator = frequency + k1 * (1 - b + (b * doc.length) / avgLength);
      score += idf(term) * (numerator / denominator);
    }
    return score;
  });
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_PATTERN) ?? [];
}
