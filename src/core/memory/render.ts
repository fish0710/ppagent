import type { MemoryRecord, TokenCounter } from '../types.js';

const BLOCK_OPEN = '<long-term-memory>';
const BLOCK_CLOSE = '</long-term-memory>';
const LEAD_IN =
  'The following notes were retrieved from long-term memory across past sessions in this project. They may or may not be relevant to the current task; verify before relying on them.';

export interface RenderedMemoryBlock {
  text: string;
  /**
   * 实际排进 text 里的记忆——预算不够被丢弃的那些不在这里。调用方用它做
   * exposure 计数/采纳检测：一条记忆被 rank.ts 选中但被这里砍掉，就从没有
   * 真的展示给模型，不该计一次曝光。
   */
  included: MemoryRecord[];
}

/**
 * 选中的记忆 → 追加到 systemPrompt 的文本块。纯函数：不判定要不要注入，
 * rank.ts 已经做过"宁缺毋滥"的门禁；这里只负责在 token 预算内把已经选好的
 * 记忆排版好，预算不够时从队尾（rank.ts 给的低优先级那端）丢弃，不做截断。
 *
 * 结果直接拼进 systemPrompt。位置固定、会话内不变，是前缀缓存安全的关键 ——
 * 见 core/context/compact.ts 对逐字节前缀一致性的要求。
 */
export function renderMemoryBlock(
  records: readonly MemoryRecord[],
  tokenCounter: TokenCounter,
  maxTokens: number,
): RenderedMemoryBlock {
  if (records.length === 0) return { text: '', included: [] };
  let selected = [...records];
  while (selected.length > 0) {
    const text = assemble(selected);
    if (tokenCounter.countText(text) <= maxTokens) return { text, included: selected };
    selected = selected.slice(0, -1);
  }
  return { text: '', included: [] };
}

function assemble(records: readonly MemoryRecord[]): string {
  const lines = records.map((record) => `- [${record.kind}] ${record.text}`);
  return `${LEAD_IN}\n\n${BLOCK_OPEN}\n${lines.join('\n')}\n${BLOCK_CLOSE}`;
}
