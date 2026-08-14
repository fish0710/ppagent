import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CliInteraction,
  NonInteractiveInteraction,
  createCliEventRenderer,
  readCliInput,
} from '../src/app/cli/index.js';
import type { UIEvent } from '../src/core/types.js';

describe('CLI interaction', () => {
  it('shows a concrete permission summary and accepts n as denial', async () => {
    let output = '';
    const input = new PassThrough();
    const interaction = new CliInteraction({
      input,
      output: new Writable({
        write(chunk, _encoding, callback) {
          output += chunk.toString();
          callback();
        },
      }),
      interactive: true,
    });
    input.end('n\n');

    try {
      await expect(
        interaction.confirm({
          message: 'rm -f /tmp/test.txt',
          detail: '{"cmd":"rm -f /tmp/test.txt"}',
        }),
      ).resolves.toBe(false);
    } finally {
      interaction.close();
    }
    expect(output).toContain('[permission] rm -f /tmp/test.txt');
    expect(output).toContain('Allow? [y/N]');
  });

  it('uses deny/null defaults when no interactive channel exists', async () => {
    const notifications: Array<{ level: string; message: string }> = [];
    const interaction = new NonInteractiveInteraction((event) => {
      notifications.push(event);
    });
    await expect(interaction.confirm({ message: 'danger' })).resolves.toBe(false);
    await expect(interaction.ask({ message: 'value?' })).resolves.toBeNull();
    await expect(
      interaction.select({ message: 'pick', options: ['one'] }),
    ).resolves.toBeNull();
    expect(notifications).toEqual([
      {
        level: 'warn',
        message: 'Non-interactive mode automatically denied permission: danger',
      },
    ]);
  });

  it('renders print mode to stdout/stderr without exposing protocol noise', () => {
    const stdout = captureStream();
    const stderr = captureStream();
    const renderer = createCliEventRenderer('print', {
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    renderer.render({ type: 'turn_start', turn: 1 });
    renderer.render({
      type: 'tool_start',
      id: 'read-1',
      name: 'read',
      args: { path: 'README.md' },
    });
    renderer.render({ type: 'text_delta', delta: 'hello' });
    renderer.render({ type: 'text_delta', delta: ' world' });
    renderer.render({ type: 'loop_end', reason: 'stop', turns: 1 });
    renderer.finish();

    expect(stdout.text()).toBe('hello world\n');
    expect(stderr.text()).toContain(
      '[tool:start] read {"path":"README.md"}',
    );
  });

  it('renders exactly one complete UIEvent per JSON line', () => {
    const output = captureStream();
    const renderer = createCliEventRenderer('json', { stdout: output.stream });
    const events: UIEvent[] = [
      { type: 'turn_start', turn: 1 },
      { type: 'text_delta', delta: 'ok' },
      {
        type: 'turn_end',
        turn: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        stopReason: 'stop',
      },
      { type: 'loop_end', reason: 'stop', turns: 1 },
    ];

    events.forEach((event) => renderer.render(event));
    renderer.finish();

    const lines = output.text().trimEnd().split('\n');
    expect(lines).toHaveLength(events.length);
    expect(lines.map((line) => JSON.parse(line) as UIEvent)).toEqual(events);
  });

  it('reads and trims a prompt from stdin', async () => {
    const input = new PassThrough();
    input.end('  inspect the workspace\n');

    await expect(readCliInput(input)).resolves.toBe('inspect the workspace');
  });
});

function captureStream(): {
  stream: Writable;
  text(): string;
} {
  let value = '';
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    text: () => value,
  };
}
