import {
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  resolve,
  sep,
} from 'node:path';
import type {
  Sandbox,
  SandboxDecision,
  WrappedCommand,
} from '../types.js';

export interface MacOsSandboxOptions {
  cwd: string;
  /** 出站 TCP 端点，例如 `localhost:1234` 或 `*:443`。默认全部禁止。 */
  networkAllowlist?: readonly string[];
  /** 测试或特殊部署可增加临时写目录；系统临时目录始终包含在内。 */
  temporaryDirectories?: readonly string[];
  sandboxExecutable?: string;
}

const PROTECTED_WRITE_ROOTS = [
  '/Applications',
  '/Library',
  '/System',
  '/bin',
  '/etc',
  '/private/etc',
  '/private/var/db',
  '/sbin',
  '/usr',
] as const;

/**
 * macOS Seatbelt 沙箱。
 *
 * 文件工具由 checkPath 做事前路径/符号链接判定；bash 则始终包装进
 * sandbox-exec，让子进程真正受到系统调用级约束。sandbox-exec 已弃用，
 * 所以所有 SBPL 细节都封装在本文件，未来替换实现不会污染工具层。
 */
export class MacOsSandbox implements Sandbox {
  readonly #workspace: string;
  readonly #writableRoots: readonly string[];
  readonly #networkAllowlist: readonly string[];
  readonly #sandboxExecutable: string;

  constructor(options: MacOsSandboxOptions) {
    if (process.platform !== 'darwin') {
      throw new Error('MacOsSandbox is only available on macOS');
    }
    this.#workspace = canonicalExistingPath(options.cwd, 'cwd');
    const temporary = [tmpdir(), '/private/tmp', ...(options.temporaryDirectories ?? [])]
      .map((path) => canonicalExistingPath(path, 'temporary directory'));
    this.#writableRoots = unique([this.#workspace, ...temporary]);
    this.#networkAllowlist = (options.networkAllowlist ?? []).map(
      validateNetworkEndpoint,
    );
    this.#sandboxExecutable = options.sandboxExecutable ?? '/usr/bin/sandbox-exec';
  }

  checkPath(path: string, op: 'read' | 'write'): SandboxDecision {
    if (!isAbsolute(path)) {
      return {
        allowed: false,
        reason: `Sandbox requires an absolute path: ${path}`,
        escalatable: false,
      };
    }
    if (op === 'read') return { allowed: true };

    let target: string;
    try {
      target = canonicalTarget(path);
    } catch (error) {
      return {
        allowed: false,
        reason: `Sandbox could not resolve write path ${path}: ${errorMessage(error)}`,
        escalatable: false,
      };
    }
    if (this.#writableRoots.some((root) => containsPath(root, target))) {
      return { allowed: true };
    }
    if (PROTECTED_WRITE_ROOTS.some((root) => containsPath(root, target))) {
      return {
        allowed: false,
        reason: `System path is not writable: ${target}`,
        escalatable: false,
      };
    }
    return {
      allowed: false,
      reason: `Write path is outside the workspace and temporary directories: ${target}`,
      escalatable: true,
    };
  }

  wrapCommand(command: string, cwd: string): WrappedCommand {
    const commandCwd = canonicalExistingPath(cwd, 'command cwd');
    if (!containsPath(this.#workspace, commandCwd)) {
      throw new Error(`Command cwd is outside the sandbox workspace: ${commandCwd}`);
    }
    return {
      command: this.#sandboxExecutable,
      args: ['-p', this.profile(), '/bin/sh', '-lc', command],
    };
  }

  /** 暴露确定性的 profile 便于审计与单测，不执行任何命令。 */
  profile(): string {
    const writeRules = this.#writableRoots
      .map((path) => `(subpath ${sbplString(path)})`)
      .join(' ');
    const networkRules = this.#networkAllowlist
      .map(
        (endpoint) =>
          `(allow network-outbound (remote tcp ${sbplString(endpoint)}))`,
      )
      .join(' ');
    return [
      '(version 1)',
      '(deny default)',
      '(allow process*)',
      '(allow signal (target self))',
      '(allow sysctl-read)',
      '(allow file-read*)',
      `(allow file-write* ${writeRules} (literal "/dev/null"))`,
      '(deny network*)',
      networkRules,
    ]
      .filter((part) => part.length > 0)
      .join(' ');
  }
}

function canonicalExistingPath(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`);
  return normalize(realpathSync.native(absolute));
}

/**
 * 目标可尚未创建：向上找到最近存在的祖先并 realpath，再拼回剩余段。
 * 这样 workspace 内指向外部的符号链接不会绕过前置检查。
 */
function canonicalTarget(path: string): string {
  let cursor = normalize(resolve(path));
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor || cursor === parse(cursor).root) break;
    suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  const base = realpathSync.native(cursor);
  return normalize(join(base, ...suffix));
}

function containsPath(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function validateNetworkEndpoint(value: string): string {
  const endpoint = value.trim();
  const match = /^(localhost|\*):(\*|\d{1,5})$/u.exec(endpoint);
  if (match === null) {
    throw new Error(
      `Invalid sandbox network endpoint ${value}; expected localhost:PORT or *:PORT`,
    );
  }
  const port = match[2];
  if (port !== '*' && (Number(port) < 1 || Number(port) > 65_535)) {
    throw new Error(`Invalid sandbox network port: ${port}`);
  }
  return endpoint;
}

function sbplString(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('Sandbox profile values must be single-line strings');
  }
  return JSON.stringify(value);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
