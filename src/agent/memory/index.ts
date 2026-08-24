import { rankMemories, type MemoryQuery } from '../../core/memory/rank.js';
import { renderMemoryBlock, type RenderedMemoryBlock } from '../../core/memory/render.js';
import type { MemoryConfig, MemoryRecord, MemoryStore, TokenCounter } from '../../core/types.js';

export * from './extract.js';
export * from './project-key.js';
export * from './store.js';
export * from './usage-log.js';
export type { RenderedMemoryBlock } from '../../core/memory/render.js';

/** project scope 与 user scope 各自的存储；由 bin/agent.ts 装配两个独立目录。 */
export interface MemoryStores {
  project: MemoryStore;
  user: MemoryStore;
}

/**
 * 按 record.scope 路由到对应的 store。存在的理由很小但必须显式：
 * JsonlMemoryStore 本身不知道 scope 语义，只认它被赋予的那一个目录，把"哪条
 * 记忆该落哪个目录"的决定权留在调用方，而不是让 store 实现悄悄兼管两个 scope。
 */
export function writeMemoryRecord(
  stores: MemoryStores,
  record: MemoryRecord,
): Promise<void> {
  return (record.scope === 'project' ? stores.project : stores.user).put(record);
}

export async function allMemoryRecords(stores: MemoryStores): Promise<MemoryRecord[]> {
  const [project, user] = await Promise.all([stores.project.all(), stores.user.all()]);
  return [...project, ...user];
}

/**
 * 按 record.scope 路由 patch。同 writeMemoryRecord 的路由理由：store 实现
 * 不认识 scope，调用方（曝光计数/采纳回填/deprecate）必须自己决定改哪个
 * 目录。调用方必须传入当前已知的 scope（而不是重新查一遍），因为触发这次
 * patch 的记忆对象本来就是调用方手上已经有的。
 */
export function patchMemoryRecord(
  stores: MemoryStores,
  scope: MemoryRecord['scope'],
  id: string,
  patch: Partial<MemoryRecord>,
): Promise<void> {
  return (scope === 'project' ? stores.project : stores.user).patch(id, patch);
}

/**
 * 急切检索的完整链路：读两个 store → 词法排序 + 槽位配额 → 排版进预算。
 * 调用方（bin/agent.ts）只负责一件事：会话启动时调一次，把结果塞进
 * systemPrompt，之后整个会话不再变 —— 前缀缓存安全的前提。
 *
 * 返回的 included 是真正进了 systemPrompt 的那些（见 RenderedMemoryBlock
 * 的文档：token 预算不够时 render.ts 会砍掉一部分），调用方要用它，而不是
 * rank.ts 排出来的候选全集，来做曝光计数——曝光必须对应"模型真的看到了"。
 *
 * text 为空字符串表示"这次不注入"，调用方不应该把它当错误处理：可能是
 * 没有匹配的记忆，也可能是记忆功能本来就没开。
 */
export async function retrieveMemoryBlock(
  stores: MemoryStores,
  query: MemoryQuery,
  config: MemoryConfig,
  tokenCounter: TokenCounter,
): Promise<RenderedMemoryBlock> {
  const records = await allMemoryRecords(stores);
  const selected = rankMemories(records, query, {
    slots: {
      project: config.slotProject,
      user: config.slotUser,
      explore: config.slotExplore,
    },
    minScore: config.minScore,
  });
  return renderMemoryBlock(selected, tokenCounter, config.injectMaxTokens);
}
