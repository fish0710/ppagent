import { createInterface, type Interface } from 'node:readline/promises';
import type { Interaction } from '../../core/types.js';

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
    options: string[];
  }): Promise<string | null> {
    if (!this.#interactive || request.options.length === 0) return null;
    this.#output.write(`${request.message}\n`);
    request.options.forEach((option, index) => {
      this.#output.write(`  ${index + 1}. ${option}\n`);
    });
    const answer = await this.#question('Select: ');
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
    }) => void = () => undefined,
  ) {
    this.#notify = notify;
  }

  async confirm(_request: Parameters<Interaction['confirm']>[0]): Promise<boolean> {
    return false;
  }

  async ask(_request: Parameters<Interaction['ask']>[0]): Promise<null> {
    return null;
  }

  async select(_request: Parameters<Interaction['select']>[0]): Promise<null> {
    return null;
  }

  notify(event: {
    level: 'info' | 'warn' | 'error';
    message: string;
  }): void {
    this.#notify(event);
  }
}

function hasTty(stream: object): boolean {
  return 'isTTY' in stream && stream.isTTY === true;
}
