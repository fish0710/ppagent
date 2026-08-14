import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CliInteraction,
  NonInteractiveInteraction,
} from '../src/app/cli/index.js';

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
    const interaction = new NonInteractiveInteraction();
    await expect(interaction.confirm({ message: 'danger' })).resolves.toBe(false);
    await expect(interaction.ask({ message: 'value?' })).resolves.toBeNull();
    await expect(
      interaction.select({ message: 'pick', options: ['one'] }),
    ).resolves.toBeNull();
  });
});
