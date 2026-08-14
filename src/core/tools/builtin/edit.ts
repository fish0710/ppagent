import { readFile, writeFile } from 'node:fs/promises';
import type { Tool } from '../../types.js';
import { textOutput } from '../execute.js';
import { objectArgs, pathSandboxPreparation, stringArg } from './common.js';

export const editTool: Tool = {
  name: 'edit',
  description: 'Replace an exact text fragment in a UTF-8 file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory.' },
      oldText: { type: 'string', description: 'Exact text to replace.' },
      newText: { type: 'string', description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    required: ['path', 'oldText', 'newText'],
    additionalProperties: false,
  },
  privileged: true,
  concurrencySafe: false,
  describe(value) {
    return `Edit file ${stringArg(objectArgs(value), 'path')}`;
  },
  prepareSandbox: (args, ctx, sandbox) =>
    pathSandboxPreparation(args, ctx, sandbox, 'write'),
  async execute(value, ctx) {
    const args = objectArgs(value);
    const path = stringArg(args, 'path');
    const oldText = stringArg(args, 'oldText');
    const newText = stringArg(args, 'newText');
    const replaceAll = args['replaceAll'] === true;
    if (oldText.length === 0) throw new Error('oldText must not be empty');
    const original = await readFile(path, { encoding: 'utf8', signal: ctx.signal });
    const occurrences = countOccurrences(original, oldText);
    if (occurrences === 0) throw new Error('oldText was not found');
    if (!replaceAll && occurrences > 1) {
      throw new Error(
        `oldText occurs ${occurrences} times; provide a unique fragment or set replaceAll`,
      );
    }
    const updated = replaceAll
      ? original.replaceAll(oldText, newText)
      : original.replace(oldText, newText);
    await writeFile(path, updated, { encoding: 'utf8', signal: ctx.signal });
    return textOutput(`Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${path}`);
  },
};

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const found = text.indexOf(needle, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + needle.length;
  }
}
