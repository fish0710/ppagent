import type {
  Sandbox,
  SandboxDecision,
  WrappedCommand,
} from '../types.js';

export interface PassthroughSandboxOptions {
  pathDecision?: (
    path: string,
    op: 'read' | 'write',
  ) => SandboxDecision;
  commandWrapper?: (command: string, cwd: string) => WrappedCommand;
}

export class PassthroughSandbox implements Sandbox {
  readonly #pathDecision: NonNullable<PassthroughSandboxOptions['pathDecision']>;
  readonly #commandWrapper: NonNullable<PassthroughSandboxOptions['commandWrapper']>;

  constructor(options: PassthroughSandboxOptions = {}) {
    this.#pathDecision = options.pathDecision ?? (() => ({ allowed: true }));
    this.#commandWrapper =
      options.commandWrapper ??
      ((command) => ({ command: '/bin/sh', args: ['-lc', command] }));
  }

  checkPath(path: string, op: 'read' | 'write'): SandboxDecision {
    return this.#pathDecision(path, op);
  }

  wrapCommand(command: string, cwd: string): WrappedCommand {
    return this.#commandWrapper(command, cwd);
  }
}
