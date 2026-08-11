import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StubAdmissionController } from '../src/agent/admission/index.js';
import { StubPermissionPolicy } from '../src/agent/permissions/index.js';
import { PassthroughSandbox } from '../src/core/sandbox/passthrough.js';
import type { Interaction, ToolContext, TraceContext } from '../src/core/types.js';
import { createBuiltinToolRegistry } from '../src/core/tools/builtin/index.js';
import { executeToolCall } from '../src/core/tools/execute.js';

describe('built-in tools', () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('registers read, write, edit and bash', () => {
    expect(createBuiltinToolRegistry().definitions().map((tool) => tool.name)).toEqual([
      'read',
      'write',
      'edit',
      'bash',
    ]);
  });

  it('writes, edits and reads files through the sandbox path gate', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ppagent-tools-'));
    const paths: Array<{ path: string; op: 'read' | 'write' }> = [];
    const sandbox = new PassthroughSandbox({
      pathDecision(path, op) {
        paths.push({ path, op });
        return { allowed: true };
      },
    });
    const ctx = toolContext(directory);

    const write = await run('write', { path: 'note.txt', content: 'hello' }, ctx, sandbox);
    const edit = await run(
      'edit',
      { path: 'note.txt', oldText: 'hello', newText: 'world' },
      ctx,
      sandbox,
    );
    const read = await run('read', { path: 'note.txt' }, ctx, sandbox);

    expect(write.isError).toBe(false);
    expect(edit.isError).toBe(false);
    expect(read).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'world' }],
    });
    expect(await readFile(join(directory, 'note.txt'), 'utf8')).toBe('world');
    expect(paths).toEqual([
      { path: join(directory, 'note.txt'), op: 'write' },
      { path: join(directory, 'note.txt'), op: 'write' },
      { path: join(directory, 'note.txt'), op: 'read' },
    ]);
  });

  it('runs bash through wrapCommand and marks non-zero exits as errors', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ppagent-tools-'));
    const wrapped: string[] = [];
    const sandbox = new PassthroughSandbox({
      commandWrapper(command) {
        wrapped.push(command);
        return { command: '/bin/sh', args: ['-lc', command] };
      },
    });
    const ctx = toolContext(directory);

    const success = await run('bash', { cmd: "printf 'hello'" }, ctx, sandbox);
    const failure = await run('bash', { cmd: "printf 'bad' >&2; exit 3" }, ctx, sandbox);

    expect(success).toMatchObject({
      isError: false,
      content: [{ text: 'Exit code: 0\nhello' }],
    });
    expect(failure).toMatchObject({
      isError: true,
      content: [{ text: 'Exit code: 3\n[stderr]\nbad' }],
    });
    expect(wrapped).toEqual(["printf 'hello'", "printf 'bad' >&2; exit 3"]);
  });

  it('kills background descendants when bash is cancelled', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ppagent-tools-'));
    const controller = new AbortController();
    const pidFile = join(directory, 'child.pid');
    let descendantPid: number | undefined;
    let execution: ReturnType<typeof run> | undefined;
    try {
      execution = run(
        'bash',
        { cmd: 'sleep 120 & echo $! > child.pid; wait' },
        toolContext(directory, controller.signal),
        new PassthroughSandbox(),
        5_000,
      );
      descendantPid = Number.parseInt(await waitForFile(pidFile), 10);
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(processIsAlive(descendantPid)).toBe(true);

      controller.abort();
      const result = await execution;

      expect(result).toMatchObject({
        isError: true,
        content: [{ text: 'Tool execution aborted.' }],
      });
      await waitForProcessExit(descendantPid);
      expect(processIsAlive(descendantPid)).toBe(false);
    } finally {
      controller.abort();
      if (execution !== undefined) await execution;
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        process.kill(descendantPid, 'SIGKILL');
      }
    }
  });

  it('returns a sandbox denial without touching the filesystem', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ppagent-tools-'));
    const result = await run(
      'write',
      { path: 'blocked.txt', content: 'nope' },
      toolContext(directory),
      new PassthroughSandbox({
        pathDecision: () => ({
          allowed: false,
          reason: 'read-only workspace',
          escalatable: false,
        }),
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      content: [{ text: 'Sandbox denied tool execution: read-only workspace' }],
    });
    await expect(readFile(join(directory, 'blocked.txt'))).rejects.toThrow();
  });
});

async function run(
  name: string,
  args: unknown,
  ctx: ToolContext,
  sandbox: PassthroughSandbox,
  toolTimeoutMs = 2_000,
) {
  return executeToolCall(
    createBuiltinToolRegistry(),
    { type: 'toolCall', id: `call-${name}`, name, arguments: args },
    ctx,
    {
      admission: new StubAdmissionController(),
      permissions: new StubPermissionPolicy(),
      sandbox,
    },
    { maxResultChars: 10_000, toolTimeoutMs },
  );
}

function toolContext(
  cwd: string,
  signal: AbortSignal = new AbortController().signal,
): ToolContext {
  const trace: TraceContext = {
    traceId: 'trace',
    spanId: 'span',
    child(name) {
      return { ...this, spanId: name };
    },
  };
  const interaction: Interaction = {
    confirm: async () => false,
    ask: async () => null,
    select: async () => null,
    notify: () => undefined,
  };
  return {
    signal,
    cwd,
    trace,
    interaction,
  };
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(path, 'utf8')).trim();
      if (value.length > 0) return value;
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await delay(10);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
