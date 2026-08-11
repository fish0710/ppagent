import { spawn } from 'node:child_process';
import type { Tool } from '../../types.js';
import { textOutput } from '../execute.js';
import { objectArgs, stringArg } from './common.js';

interface PreparedBashArgs {
  executable: string;
  executableArgs: string[];
}

export const bashTool: Tool = {
  name: 'bash',
  description: 'Run a shell command in the working directory.',
  parameters: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'Shell command to execute.' },
    },
    required: ['cmd'],
    additionalProperties: false,
  },
  privileged: true,
  concurrencySafe: false,
  prepareSandbox(value, ctx, sandbox) {
    const args = objectArgs(value);
    const wrapped = sandbox.wrapCommand(stringArg(args, 'cmd'), ctx.cwd);
    return {
      allowed: true,
      args: { executable: wrapped.command, executableArgs: wrapped.args },
    };
  },
  async execute(value, ctx) {
    const args = preparedBashArgs(value);
    const result = await runProcess(
      args.executable,
      args.executableArgs,
      ctx.cwd,
      ctx.signal,
    );
    const sections = [`Exit code: ${result.code}`];
    if (result.stdout.length > 0) sections.push(result.stdout);
    if (result.stderr.length > 0) sections.push(`[stderr]\n${result.stderr}`);
    return textOutput(sections.join('\n'), result.code !== 0);
  },
};

function preparedBashArgs(value: unknown): PreparedBashArgs {
  const args = objectArgs(value);
  const executable = stringArg(args, 'executable');
  const executableArgs = args['executableArgs'];
  if (
    !Array.isArray(executableArgs) ||
    !executableArgs.every((item) => typeof item === 'string')
  ) {
    throw new Error('Expected sandbox-prepared command arguments');
  }
  return { executable, executableArgs };
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (signal.aborted) throw signal.reason ?? new Error('Command aborted');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      killTimer.unref();
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new Error('Command aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      if (signal.aborted) {
        reject(signal.reason ?? new Error('Command aborted'));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
