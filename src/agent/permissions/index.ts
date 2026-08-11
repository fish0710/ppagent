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
