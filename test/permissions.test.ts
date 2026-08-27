import { describe, expect, it, vi } from 'vitest';
import { InteractivePermissionPolicy } from '../src/agent/permissions/index.js';
import { AutoApproveInteraction } from '../src/app/cli/index.js';
import type { Interaction, PermissionRequest } from '../src/core/types.js';

const REQUEST: PermissionRequest = {
  toolName: 'bash',
  summary: 'rm -f /tmp/test.txt',
  detail: '{"cmd":"rm -f /tmp/test.txt"}',
};

describe('InteractivePermissionPolicy', () => {
  it.each([
    ['allow', 'allow'],
    ['allowAlways', 'allowAlways'],
    ['deny', 'deny'],
    [null, 'deny'],
  ] as const)('maps select=%s to %s', async (choice, expected) => {
    const select = vi.fn(async () => choice);
    const interaction = interactionWith(select);

    await expect(
      new InteractivePermissionPolicy().check(REQUEST, interaction),
    ).resolves.toBe(expected);
    expect(select).toHaveBeenCalledWith({
      message: 'rm -f /tmp/test.txt',
      options: ['allow', 'allowAlways', 'deny'],
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

  it('remembers allowAlways for the tool and stops asking within the same policy instance', async () => {
    const select = vi.fn(async () => 'allowAlways' as const);
    const interaction = interactionWith(select);
    const policy = new InteractivePermissionPolicy();

    await expect(policy.check(REQUEST, interaction)).resolves.toBe('allowAlways');
    await expect(policy.check(REQUEST, interaction)).resolves.toBe('allow');
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('does not let allowAlways leak across different sandboxReason escalations', async () => {
    const select = vi.fn(async () => 'allowAlways' as const);
    const interaction = interactionWith(select);
    const policy = new InteractivePermissionPolicy();

    await policy.check(REQUEST, interaction);
    await policy.check(
      { ...REQUEST, sandboxReason: 'network write outside allowlist' },
      interaction,
    );
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('does not memoize a plain allow', async () => {
    const select = vi.fn(async () => 'allow' as const);
    const interaction = interactionWith(select);
    const policy = new InteractivePermissionPolicy();

    await policy.check(REQUEST, interaction);
    await policy.check(REQUEST, interaction);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it('resolves to allow through the explicit AutoApproveInteraction benchmark path', async () => {
    // 策略从 confirm() 切到 select() 那次改动最容易悄悄打断
    // --permission-mode allow：AutoApproveInteraction.select() 一旦漏掉
    // 'allow'，整条 benchmark 路径会从全部放行变成全部拒绝且没有任何提示。
    const notifications: Array<{ level: string; message: string }> = [];
    const interaction = new AutoApproveInteraction((event) => notifications.push(event));
    const policy = new InteractivePermissionPolicy();

    await expect(policy.check(REQUEST, interaction)).resolves.toBe('allow');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.level).toBe('warn');
  });
});

function interactionWith(
  select: Interaction['select'],
  notify: Interaction['notify'] = () => undefined,
): Interaction {
  return {
    confirm: async () => false,
    ask: async () => null,
    select,
    notify,
  };
}
