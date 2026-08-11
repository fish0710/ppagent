import { readFile } from 'node:fs/promises';
import type { Tool } from '../../types.js';
import { textOutput } from '../execute.js';
import { objectArgs, pathSandboxPreparation, stringArg } from './common.js';

export const readTool: Tool = {
  name: 'read',
  description: 'Read a UTF-8 text file, optionally selecting a range of lines.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory.' },
      offset: { type: 'integer', description: 'One-based first line to return.' },
      limit: { type: 'integer', description: 'Maximum number of lines to return.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  concurrencySafe: true,
  prepareSandbox: (args, ctx, sandbox) =>
    pathSandboxPreparation(args, ctx, sandbox, 'read'),
  async execute(value, ctx) {
    const args = objectArgs(value);
    const path = stringArg(args, 'path');
    const offset = integerArg(args, 'offset', 1);
    const limit = integerArg(args, 'limit', Number.POSITIVE_INFINITY);
    if (offset < 1) throw new Error('offset must be at least 1');
    if (limit < 1) throw new Error('limit must be at least 1');
    const text = await readFile(path, { encoding: 'utf8', signal: ctx.signal });
    if (offset === 1 && limit === Number.POSITIVE_INFINITY) return textOutput(text);
    const lines = text.split('\n');
    return textOutput(lines.slice(offset - 1, offset - 1 + limit).join('\n'));
  },
};

function integerArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const value = args[key];
  return value === undefined ? fallback : (value as number);
}
