import { resolve } from 'node:path';
import type {
  Sandbox,
  ToolContext,
  ToolSandboxPreparation,
} from '../../types.js';

export function objectArgs(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected validated object arguments');
  }
  return value as Record<string, unknown>;
}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`Expected string argument: ${key}`);
  return value;
}

/** 用 indexOf 循环数行，避免在大文件上 split 出一个不必要的巨大数组。 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 1;
  let idx = text.indexOf('\n');
  while (idx !== -1) {
    count += 1;
    idx = text.indexOf('\n', idx + 1);
  }
  return text.endsWith('\n') ? count - 1 : count;
}

export function pathSandboxPreparation(
  value: unknown,
  ctx: ToolContext,
  sandbox: Sandbox,
  op: 'read' | 'write',
): ToolSandboxPreparation {
  const args = objectArgs(value);
  const path = resolve(ctx.cwd, stringArg(args, 'path'));
  const decision = sandbox.checkPath(path, op);
  return decision.allowed
    ? { allowed: true, args: { ...args, path } }
    : decision;
}
