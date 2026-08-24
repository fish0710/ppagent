import { rankMemories, type MemorySlots } from '../../core/memory/rank.js';
import type { Tool, ToolOutput } from '../../core/types.js';
import { passthroughPrepare, textOutput } from '../../core/tools/execute.js';
import { objectArgs, stringArg } from '../../core/tools/builtin/common.js';
import { allMemoryRecords, type MemoryStores } from '../memory/index.js';

export interface MemorySearchToolOptions {
  stores: MemoryStores;
  projectKey: string;
  /**
   * 惰性检索（模型主动调 search）比急切检索（会话启动时的自动注入）更该
   * "尽量给"：模型已经用具体的 query 表达了意图，门槛可以比急切检索更低、
   * 条数可以更多——落地计划 4.1 节的"急切宁缺毋滥 / 惰性尽量给"就是这条。
   * 默认无 explore 槽：探索槽是急切检索给新记忆曝光机会的机制，模型主动
   * 搜索时不需要这层保护。
   */
  slots?: MemorySlots;
  minScore?: number;
}

const DEFAULT_SLOTS: MemorySlots = { project: 5, user: 3, explore: 0 };
const DEFAULT_MIN_SCORE = 0;

/**
 * 默认不注册（config.memory.searchTool = false）：工具定义会被 chat
 * template 渲染进 system 段，每次请求都计费，先证明急切检索不够用再开。
 *
 * v1 明确的范围切割：调用这个工具不计曝光、不参与采纳检测——那套反馈闭环
 * （agent/session.ts 的 #trackMemoryUsage）目前只覆盖急切检索这一条路径。
 * 给搜索结果也接上反馈需要在一次会话里合并两条路径的曝光名单，为了这个
 * 默认关闭、还没验证过价值的工具先做这个复杂度不划算，留到有数据支撑
 * 再说。
 */
export function createMemorySearchTool(options: MemorySearchToolOptions): Tool {
  return {
    name: 'memory_search',
    description:
      'Search long-term memory for facts, conventions, decisions, and pitfalls recorded from past sessions in this project.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    concurrencySafe: true,
    describe(value) {
      return `Search memory: ${stringArg(objectArgs(value), 'query')}`;
    },
    prepareSandbox: passthroughPrepare,
    async execute(value): Promise<ToolOutput> {
      const query = stringArg(objectArgs(value), 'query').trim();
      if (query.length === 0) throw new Error('Search query must not be empty');
      const records = await allMemoryRecords(options.stores);
      const selected = rankMemories(
        records,
        { text: query, projectKey: options.projectKey },
        {
          slots: options.slots ?? DEFAULT_SLOTS,
          minScore: options.minScore ?? DEFAULT_MIN_SCORE,
        },
      );
      if (selected.length === 0) return textOutput('No matching memories found.', false);
      const lines = selected.map((record) => `[${record.kind}] ${record.text}`);
      return textOutput(lines.join('\n'), false);
    },
  };
}
