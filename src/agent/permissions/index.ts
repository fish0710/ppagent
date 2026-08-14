import type {
  Interaction,
  PermissionDecision,
  PermissionPolicy,
  PermissionRequest,
} from '../../core/types.js';

export class StubPermissionPolicy implements PermissionPolicy {
  #decision: PermissionDecision;

  constructor(decision: PermissionDecision = 'allow') {
    this.#decision = decision;
  }

  setDecision(decision: PermissionDecision): void {
    this.#decision = decision;
  }

  async check(
    _req: PermissionRequest,
    _interaction: Interaction,
  ): Promise<PermissionDecision> {
    return this.#decision;
  }
}

/** 真实权限策略只依赖 Interaction；终端、TUI、RPC 各自决定如何呈现。 */
export class InteractivePermissionPolicy implements PermissionPolicy {
  async check(
    req: PermissionRequest,
    interaction: Interaction,
  ): Promise<PermissionDecision> {
    const detail = [
      ...(req.sandboxReason === undefined
        ? []
        : [`Sandbox reason: ${req.sandboxReason}`]),
      ...(req.detail === undefined ? [] : [req.detail]),
    ].join('\n');
    try {
      const allowed = await interaction.confirm({
        message: req.summary,
        ...(detail.length === 0 ? {} : { detail }),
      });
      return allowed ? 'allow' : 'deny';
    } catch (error) {
      interaction.notify({
        level: 'warn',
        message: `Permission prompt failed; denying by default: ${errorMessage(error)}`,
      });
      return 'deny';
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
