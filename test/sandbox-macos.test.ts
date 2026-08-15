import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, realpathSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MacOsSandbox } from '../src/core/sandbox/macos.js';

const temporaryDirectories: string[] = [];
const externalFiles: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
  await Promise.all(
    externalFiles.splice(0).map((path) =>
      rm(path, { force: true }),
    ),
  );
});

const macIt = process.platform === 'darwin' ? it : it.skip;

describe('MacOsSandbox', () => {
  macIt('allows workspace/temp writes and classifies external/system paths', async () => {
    const workspace = await temporaryDirectory('ppagent-m9-workspace-');
    const sandbox = new MacOsSandbox({ cwd: workspace });

    expect(sandbox.checkPath(join(workspace, 'src', 'new.ts'), 'write')).toEqual({
      allowed: true,
    });
    expect(sandbox.checkPath(join(tmpdir(), 'ppagent.log'), 'write')).toEqual({
      allowed: true,
    });
    expect(sandbox.checkPath('/Users/Shared/ppagent-m9-outside.txt', 'write')).toMatchObject({
      allowed: false,
      escalatable: true,
    });
    expect(sandbox.checkPath('/etc/hosts', 'write')).toMatchObject({
      allowed: false,
      escalatable: false,
      reason: expect.stringContaining('System path'),
    });
    expect(sandbox.checkPath('/etc/hosts', 'read')).toEqual({ allowed: true });
  });

  macIt('resolves a symlink ancestor before deciding whether a write is in workspace', async () => {
    const workspace = await temporaryDirectory('ppagent-m9-symlink-workspace-');
    await mkdir(join(workspace, 'links'));
    await symlink('/Users/Shared', join(workspace, 'links', 'outside'));
    const sandbox = new MacOsSandbox({ cwd: workspace });

    expect(
      sandbox.checkPath(join(workspace, 'links', 'outside', 'escaped.txt'), 'write'),
    ).toMatchObject({ allowed: false, escalatable: true });
  });

  macIt('builds an audited sandbox-exec command with network denied by default', async () => {
    const workspace = await temporaryDirectory('ppagent-m9-profile-');
    const sandbox = new MacOsSandbox({ cwd: workspace });
    const wrapped = sandbox.wrapCommand('printf ok', workspace);

    expect(wrapped.command).toBe('/usr/bin/sandbox-exec');
    expect(wrapped.args.slice(0, 2)).toEqual(['-p', expect.any(String)]);
    expect(wrapped.args.slice(-3)).toEqual(['/bin/sh', '-lc', 'printf ok']);
    expect(wrapped.args[1]).toContain('(deny network*)');
    expect(wrapped.args[1]).toContain(
      `(subpath ${JSON.stringify(realpathSync.native(workspace))})`,
    );
  });

  macIt('validates and renders explicit TCP allowlist endpoints', async () => {
    const workspace = await temporaryDirectory('ppagent-m9-network-');
    const sandbox = new MacOsSandbox({
      cwd: workspace,
      networkAllowlist: ['localhost:1234', '*:443'],
    });

    expect(sandbox.profile()).toContain(
      '(allow network-outbound (remote tcp "localhost:1234"))',
    );
    expect(sandbox.profile()).toContain(
      '(allow network-outbound (remote tcp "*:443"))',
    );
    expect(
      () => new MacOsSandbox({ cwd: workspace, networkAllowlist: ['example.com:443'] }),
    ).toThrow('Invalid sandbox network endpoint');
  });

  macIt('executes sandbox-exec and blocks a write outside allowed roots', async () => {
    const workspace = await temporaryDirectory('ppagent-m9-runtime-');
    const sandbox = new MacOsSandbox({ cwd: workspace });
    const allowed = join(workspace, 'allowed.txt');
    const outside = `/Users/Shared/ppagent-m9-${randomUUID()}.txt`;
    externalFiles.push(outside);

    await execute(sandbox.wrapCommand(`printf allowed > ${allowed}`, workspace));
    await expect(accessPromise(allowed)).resolves.toBeUndefined();

    await expect(
      execute(sandbox.wrapCommand(`printf blocked > ${outside}`, workspace)),
    ).rejects.toThrow();
    await expect(accessPromise(outside)).rejects.toThrow();
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function execute(wrapped: { command: string; args: string[] }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(wrapped.command, wrapped.args, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

function accessPromise(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    access(path, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}
