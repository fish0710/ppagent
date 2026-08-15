import type { Tool, ToolContext, ToolOutput } from '../../core/types.js';
import { passthroughPrepare, textOutput } from '../../core/tools/execute.js';
import { objectArgs, stringArg } from '../../core/tools/builtin/common.js';

export interface SpawnSubagentResult {
  content: string;
  isError?: boolean;
}

export type SpawnSubagentRunner = (
  task: string,
  context: ToolContext,
) => Promise<SpawnSubagentResult>;

/** 创建受 AdmissionController 约束的并行分析工具。 */
export function createSpawnSubagentTool(run: SpawnSubagentRunner): Tool {
  return {
    name: 'spawn_subagent',
    description:
      'Delegate one independent analysis task to a resource-admitted subagent and return its final report.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'A self-contained task with the context needed by the subagent.',
        },
      },
      required: ['task'],
      additionalProperties: false,
    },
    requiresAdmission: true,
    concurrencySafe: true,
    describe(value) {
      return `Delegate subagent: ${stringArg(objectArgs(value), 'task')}`;
    },
    prepareSandbox: passthroughPrepare,
    async execute(value, context): Promise<ToolOutput> {
      const task = stringArg(objectArgs(value), 'task').trim();
      if (task.length === 0) throw new Error('Subagent task must not be empty');
      const result = await run(task, context);
      return textOutput(result.content, result.isError === true);
    },
  };
}
