import { describe, expect, it, vi } from 'vitest';
import { InteractivePermissionPolicy } from '../src/agent/permissions/index.js';
import type { Interaction, PermissionRequest } from '../src/core/types.js';

const REQUEST: PermissionRequest = {
  toolName: 'bash',
  summary: 'rm -f /tmp/test.txt',
  detail: '{"cmd":"rm -f /tmp/test.txt"}',
};

describe('InteractivePermissionPolicy', () => {
  it.each([
    [true, 'allow'],
    [false, 'deny'],
  ] as const)('maps confirm=%s to %s', async (confirmed, expected) => {
    const confirm = vi.fn(async () => confirmed);
    const interaction = interactionWith(confirm);

    await expect(
      new InteractivePermissionPolicy().check(REQUEST, interaction),
    ).resolves.toBe(expected);
    expect(confirm).toHaveBeenCalledWith({
      message: 'rm -f /tmp/test.txt',
      detail: '{"cmd":"rm -f /tmp/test.txt"}',
    });
  });

  it('denies safely and notifies when the UI prompt fails', async () => {
    const notify = vi.fn();
    const interaction = interactionWith(async () => {
      throw new Error('stdin closed');
    }, notify);

    await expect(
      new InteractivePermissionPolicy().check(REQUEST, interaction),
    ).resolves.toBe('deny');
    expect(notify).toHaveBeenCalledWith({
      level: 'warn',
      message: expect.stringContaining('stdin closed'),
    });
  });
});

function interactionWith(
  confirm: Interaction['confirm'],
  notify: Interaction['notify'] = () => undefined,
): Interaction {
  return {
    confirm,
    ask: async () => null,
    select: async () => null,
    notify,
  };
}
