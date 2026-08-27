import { createInterface, type Interface } from 'node:readline/promises';
import type { Interaction, UIEvent } from '../../core/types.js';

export type CliOutputMode = 'print' | 'json';

export interface CliEventRenderer {
  render(event: UIEvent): void;
  finish(): void;
}

export interface CliRendererOptions {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/** 创建 M8 的稳定输出协议；JSON 模式的 stdout 不混入人类可读日志。 */
export function createCliEventRenderer(
  mode: CliOutputMode,
  options: CliRendererOptions = {},
): CliEventRenderer {
  return mode === 'json'
    ? new JsonCliEventRenderer(options.stdout)
    : new PrintCliEventRenderer(options);
}

export class PrintCliEventRenderer implements CliEventRenderer {
  readonly #stdout: NodeJS.WritableStream;
  readonly #stderr: NodeJS.WritableStream;
  #wroteText = false;

  constructor(options: CliRendererOptions = {}) {
    this.#stdout = options.stdout ?? process.stdout;
    this.#stderr = options.stderr ?? process.stderr;
  }

  render(event: UIEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.#stdout.write(event.delta);
        this.#wroteText ||= event.delta.length > 0;
        break;
      case 'tool_start':
        this.#stderr.write(
          `\n[tool:start] ${event.name} ${safeJson(event.args)}\n`,
        );
        break;
      case 'tool_end':
        this.#stderr.write(
          `[tool:end] ${event.name} ${event.isError ? 'error' : 'ok'}: ${event.preview}\n`,
        );
        break;
      case 'error':
        this.#stderr.write(`\n${event.message}\n`);
        break;
      case 'notify':
        this.#stderr.write(`[${event.level}] ${event.message}\n`);
        break;
      case 'compacted':
        this.#stderr.write(
          `\n[context:compacted] ${event.trigger} ${event.tokensBefore} → ${event.tokensAfter} tokens${
            event.resourceSource === undefined ? '' : ` (${event.resourceSource})`
          }\n`,
        );
        break;
      case 'admission_denied':
        this.#stderr.write(
          `\n[admission:denied] ${event.reason}${
            event.retryAfterMs === null ? '' : ` (retry after ${event.retryAfterMs}ms)`
          }\n`,
        );
        break;
      case 'turn_start':
      case 'thinking_delta':
      case 'permission_request':
      case 'permission_resolved':
      case 'turn_end':
      case 'loop_end':
        break;
    }
  }

  finish(): void {
    if (this.#wroteText) this.#stdout.write('\n');
    this.#wroteText = false;
  }
}

export class JsonCliEventRenderer implements CliEventRenderer {
  readonly #stdout: NodeJS.WritableStream;

  constructor(stdout: NodeJS.WritableStream = process.stdout) {
    this.#stdout = stdout;
  }

  render(event: UIEvent): void {
    this.#stdout.write(`${safeJson(event)}\n`);
  }

  finish(): void {}
}

/** 读取管道输入；调用方负责在 TTY 时拒绝缺省 prompt，避免无限等待。 */
export async function readCliInput(
  input: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  let text = '';
  for await (const chunk of input as AsyncIterable<string | Buffer>) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return text.trim();
}

export interface CliInteractionOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** 测试可显式开启；默认只在 TTY 中提问。 */
  interactive?: boolean;
}

/** readline 只存在于 app 层；PermissionPolicy 与 core 只认识 Interaction。 */
export class CliInteraction implements Interaction {
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  readonly #interactive: boolean;
  #readline: Interface | undefined;

  constructor(options: CliInteractionOptions = {}) {
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stderr;
    this.#interactive =
      options.interactive ??
      (hasTty(this.#input) && hasTty(this.#output));
  }

  async confirm(request: {
    message: string;
    detail?: string;
  }): Promise<boolean> {
    this.#output.write(`\n[permission] ${request.message}\n`);
    if (request.detail !== undefined) {
      this.#output.write(`${request.detail}\n`);
    }
    if (!this.#interactive) {
      this.#output.write('Non-interactive input: denied.\n');
      return false;
    }
    const answer = await this.#question('Allow? [y/N] ');
    return /^(?:y|yes)$/iu.test(answer.trim());
  }

  async ask(request: {
    message: string;
    secret?: boolean;
  }): Promise<string | null> {
    if (!this.#interactive) return null;
    // M7 只需要普通输入；secret 的无回显实现留给完整 TUI。
    return this.#question(`${request.message} `);
  }

  async select(request: {
    message: string;
    detail?: string;
    options: string[];
  }): Promise<string | null> {
    if (!this.#interactive || request.options.length === 0) return null;
    this.#output.write(`${request.message}\n`);
    if (request.detail !== undefined) {
      this.#output.write(`${request.detail}\n`);
    }
    request.options.forEach((option, index) => {
      this.#output.write(`  ${index + 1}. ${option}\n`);
    });
    const answer = (await this.#question('Select: ')).trim();
    const byLetter = selectByLetter(request.options, answer);
    if (byLetter !== undefined) return byLetter;
    const index = Number(answer) - 1;
    return Number.isInteger(index) ? request.options[index] ?? null : null;
  }

  notify(event: {
    level: 'info' | 'warn' | 'error';
    message: string;
  }): void {
    this.#output.write(`[${event.level}] ${event.message}\n`);
  }

  close(): void {
    this.#readline?.close();
    this.#readline = undefined;
  }

  #interface(): Interface {
    this.#readline ??= createInterface({
      input: this.#input,
      output: this.#output,
      terminal: this.#interactive,
    });
    return this.#readline;
  }

  async #question(prompt: string): Promise<string> {
    const readline = this.#interface();
    try {
      return await readline.question(prompt);
    } finally {
      // readline 在 terminal 模式下会接管 Ctrl+C；回答完成就释放，让随后运行
      // 的模型流或工具能重新由进程级 SIGINT handler 取消。
      if (this.#readline === readline) {
        readline.close();
        this.#readline = undefined;
      }
    }
  }
}

export class NonInteractiveInteraction implements Interaction {
  readonly #notify: (event: {
    level: 'info' | 'warn' | 'error';
    message: string;
  }) => void;

  constructor(
    notify: (event: {
      level: 'info' | 'warn' | 'error';
      message: string;
    }) => void = ({ level, message }) => {
      process.stderr.write(`[${level}] ${message}\n`);
    },
  ) {
    this.#notify = notify;
  }

  async confirm(
    request: Parameters<Interaction['confirm']>[0],
  ): Promise<boolean> {
    this.notify({
      level: 'warn',
      message: `Non-interactive mode automatically denied permission: ${request.message}`,
    });
    return false;
  }

  async ask(_request: Parameters<Interaction['ask']>[0]): Promise<null> {
    return null;
  }

  async select(request: Parameters<Interaction['select']>[0]): Promise<null> {
    this.notify({
      level: 'warn',
      message: `Non-interactive mode automatically denied permission: ${request.message}`,
    });
    return null;
  }

  notify(event: {
    level: 'info' | 'warn' | 'error';
    message: string;
  }): void {
    this.#notify(event);
  }
}

/** 隔离评测环境显式启用的无头批准策略；默认 CLI 永远不会自行选择它。 */
export class AutoApproveInteraction implements Interaction {
  readonly #notify: (event: {
    level: 'info' | 'warn' | 'error';
    message: string;
  }) => void;

  constructor(
    notify: (event: {
      level: 'info' | 'warn' | 'error';
      message: string;
    }) => void,
  ) {
    this.#notify = notify;
  }

  async confirm(request: Parameters<Interaction['confirm']>[0]): Promise<boolean> {
    this.#notify({
      level: 'warn',
      message: `Explicit auto-approve mode allowed permission: ${request.message}`,
    });
    return true;
  }

  async ask(): Promise<null> {
    return null;
  }

  async select(request: Parameters<Interaction['select']>[0]): Promise<string | null> {
    this.#notify({
      level: 'warn',
      message: `Explicit auto-approve mode allowed permission: ${request.message}`,
    });
    return request.options.includes('allow') ? 'allow' : (request.options[0] ?? null);
  }

  notify(event: Parameters<Interaction['notify']>[0]): void {
    this.#notify(event);
  }
}

/**
 * y/a/n 是权限对话框（allow/allowAlways/deny）的肌肉记忆快捷键；对其余
 * 通用 select() 调用（选项不含这三个字面量）静默不匹配，回落到数字选择。
 */
function selectByLetter(options: string[], answer: string): string | null | undefined {
  const letter = answer.toLowerCase();
  if (letter === 'y' && options.includes('allow')) return 'allow';
  if (letter === 'a' && options.includes('allowAlways')) return 'allowAlways';
  if (letter === 'n' && options.includes('deny')) return 'deny';
  return undefined;
}

function hasTty(stream: object): boolean {
  return 'isTTY' in stream && stream.isTTY === true;
}

function safeJson(value: unknown): string {
  const ancestors: object[] = [];
  try {
    return JSON.stringify(value, function (
      this: object,
      _key,
      entry: unknown,
    ) {
      if (typeof entry === 'bigint') return entry.toString();
      if (typeof entry !== 'object' || entry === null) return entry;
      // 只保留当前访问路径：兄弟字段共享引用不是循环，不能误标。
      while (
        ancestors.length > 0 &&
        ancestors.at(-1) !== this
      ) {
        ancestors.pop();
      }
      if (ancestors.includes(entry)) return '[Circular]';
      ancestors.push(entry);
      return entry;
    });
  } catch {
    return JSON.stringify({
      type: 'error',
      message: 'CLI could not serialize an event.',
    });
  }
}
