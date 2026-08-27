import { writeFile } from 'node:fs/promises';
import type { Tool, ToolOutput } from '../../types.js';
import { textOutput } from '../execute.js';
import { countLines, objectArgs, pathSandboxPreparation, stringArg } from './common.js';

export const writeTool: Tool = {
  name: 'write',
  description: 'Write UTF-8 text to a file, replacing its previous contents.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory.' },
      content: { type: 'string', description: 'Complete new file contents.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  privileged: true,
  concurrencySafe: false,
  describe(value) {
    return `Write file ${stringArg(objectArgs(value), 'path')}`;
  },
  prepareSandbox: (args, ctx, sandbox) =>
    pathSandboxPreparation(args, ctx, sandbox, 'write'),
  async execute(value, ctx) {
    const args = objectArgs(value);
    const path = stringArg(args, 'path');
    const content = stringArg(args, 'content');
    await writeFile(path, content, { encoding: 'utf8', signal: ctx.signal });
    const bytes = Buffer.byteLength(content, 'utf8');
    const output: ToolOutput = {
      ...textOutput(`Wrote ${bytes} bytes to ${path}`),
      display: { kind: 'write', path, lines: countLines(content), bytes },
    };
    return output;
  },
};
