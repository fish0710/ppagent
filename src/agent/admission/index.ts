import type {
  AdmissionController,
  AdmissionDecision,
} from '../../core/types.js';

export class StubAdmissionController implements AdmissionController {
  #decision: AdmissionDecision;

  constructor(decision: AdmissionDecision = { ok: true }) {
    this.#decision = decision;
  }

  setDecision(decision: AdmissionDecision): void {
    this.#decision = decision;
  }

  async canSpawnSubagent(): Promise<AdmissionDecision> {
    return { ...this.#decision };
  }
}
