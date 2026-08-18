import type { FileOperations, Message } from '../types.js';

/** 内置工具里参数名统一是 path；三者的 schema 已确认一致。 */
const READ_TOOLS = new Set(['read']);
const WRITE_TOOLS = new Set(['write', 'edit']);

export interface ExtractFileOperationsOptions {
  /** 上一版清单，合并后继续累积。 */
  previous?: FileOperations;
  /** 条数上限；超出时先砍 read。 */
  maxFiles: number;
}

/**
 * 从 toolCall 块里提取 agent 动过的文件，与上一版合并累积。
 *
 * 这是"凡是结构里已经有的就不问模型"的落点：路径就在
 * `ToolCallBlock.arguments.path` 里，让模型转述只会引入漏项和错字，而且错了
 * 没人发现。摘要模板里的 <files-read>/<files-modified> 是 harness 拼上去的
 * 成品，不是要模型填的格式。
 *
 * 纯函数，不改输入。只扫被折叠的那段消息 —— 保留区里的 toolCall 模型还看得见
 * 原文，不需要清单代劳；等它们下次被折叠时自然会进来。
 */
export function extractFileOperations(
  messages: readonly Message[],
  options: ExtractFileOperationsOptions,
): FileOperations {
  const read: string[] = [...(options.previous?.readFiles ?? [])];
  const modified: string[] = [...(options.previous?.modifiedFiles ?? [])];

  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type !== 'toolCall') continue;
      const path = pathArgument(block.arguments);
      if (path === undefined) continue;
      if (WRITE_TOOLS.has(block.name)) modified.push(path);
      else if (READ_TOOLS.has(block.name)) read.push(path);
    }
  }

  // 读过又改过的只算 modified —— "改过"是更强的信息，重复列出只占位置。
  const modifiedSet = new Set(modified);
  return capped(
    unique(read).filter((path) => !modifiedSet.has(path)),
    unique(modified),
    options.maxFiles,
    options.previous?.omittedCount ?? 0,
  );
}

/** 拼进摘要的成品文本；清单为空时返回空串，不留空标签。 */
export function formatFileOperations(operations: FileOperations): string {
  const blocks: string[] = [];
  if (operations.readFiles.length > 0) {
    blocks.push(`<files-read>\n${operations.readFiles.join('\n')}\n</files-read>`);
  }
  if (operations.modifiedFiles.length > 0) {
    blocks.push(
      `<files-modified>\n${operations.modifiedFiles.join('\n')}\n</files-modified>`,
    );
  }
  if (blocks.length === 0) return '';
  if ((operations.omittedCount ?? 0) > 0) {
    // 不标注的话，被裁剪过的清单看起来像"总共只碰过这些"，比缺失更误导。
    blocks.push(`<files-omitted>${operations.omittedCount} more</files-omitted>`);
  }
  return blocks.join('\n');
}

/**
 * 超限时先砍 read 再砍 modified，两边都从最早的开始砍 —— 最近动过的文件
 * 与当前工作的相关性最高。
 */
function capped(
  read: readonly string[],
  modified: readonly string[],
  maxFiles: number,
  previousOmitted: number,
): FileOperations {
  const total = read.length + modified.length;
  if (total <= maxFiles) {
    return {
      readFiles: [...read],
      modifiedFiles: [...modified],
      ...(previousOmitted > 0 ? { omittedCount: previousOmitted } : {}),
    };
  }
  const modifiedKept = modified.slice(Math.max(0, modified.length - maxFiles));
  const readBudget = Math.max(0, maxFiles - modifiedKept.length);
  const readKept = read.slice(Math.max(0, read.length - readBudget));
  return {
    readFiles: readKept,
    modifiedFiles: modifiedKept,
    omittedCount: previousOmitted + (total - readKept.length - modifiedKept.length),
  };
}

/** 保留最后一次出现的位置：最近动过的排在后面，裁剪时先被保住。 */
function unique(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = paths.length - 1; index >= 0; index -= 1) {
    const path = paths[index];
    if (path === undefined || seen.has(path)) continue;
    seen.add(path);
    result.unshift(path);
  }
  return result;
}

function pathArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const path = (args as { path?: unknown }).path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}
