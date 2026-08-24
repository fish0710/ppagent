import type { Message, MemoryRecord } from '../types.js';

/**
 * 采纳检测：不问模型，harness 自己算。检查一条记忆文本里的"独特标识符"
 * （路径、命令、符号名——不是停用词那种大路货）是否在会话产出的 assistant
 * 文本或工具调用参数里出现过。
 *
 * 这是代理指标，不是声明：会有假阳性（模型本来就会用到那个路径，跟有没有
 * 见过这条记忆无关）。选择它而不是让模型每轮输出 `<memory_use>` 表态块，
 * 是因为本地模型连 TEXT ONLY 都守不住结构化契约（agent/summarize/llm.ts
 * 为此写了三道防线），再加一层表态块只会重新扩大"信任模型"的面积——
 * 这正是 M5 二期想收窄的东西。见 core/context/files.ts 用同样的手法从
 * ToolCallBlock.arguments.path 里挖文件清单，而不是让模型转述"我读过哪些
 * 文件"。
 *
 * 纯函数，不做任何 IO 或状态变更；调用方（agent/session.ts）负责把结果
 * 写回 MemoryStore。
 */

export interface AdoptionResult {
  memoryId: string;
  adopted: boolean;
}

const IDENTIFIER_PATTERN = /[A-Za-z0-9_][A-Za-z0-9_./-]{3,}/gu;

export function detectAdoption(
  records: readonly MemoryRecord[],
  messages: readonly Message[],
): AdoptionResult[] {
  const haystack = buildHaystack(messages);
  return records.map((record) => ({
    memoryId: record.id,
    adopted: distinctiveTokens(record.text).some((token) => haystack.includes(token)),
  }));
}

/**
 * 只挑"看起来像标识符"的 token：含路径分隔符/点号/下划线，或含数字——
 * 排除掉普通英文单词，否则几乎任何回复都会被判定为"采纳"，检测就失去了
 * 意义。短 token（<4 字符）天然噪声大，直接过滤掉。
 */
function distinctiveTokens(text: string): string[] {
  const matches = text.toLowerCase().match(IDENTIFIER_PATTERN) ?? [];
  return matches.filter((token) => /[/._]/u.test(token) || /\d/u.test(token));
}

function buildHaystack(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'toolCall') parts.push(JSON.stringify(block.arguments));
    }
  }
  return parts.join('\n').toLowerCase();
}
