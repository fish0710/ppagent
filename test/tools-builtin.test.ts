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
    { maxResultChars: 10_000, toolTimeoutMs: 2_000 },
  );
}

function toolContext(cwd: string): ToolContext {
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
    signal: new AbortController().signal,
    cwd,
    trace,
    interaction,
  };
}
