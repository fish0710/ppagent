import type {
  AdmissionController,
  AdmissionDecision,
  ResourceProbe,
} from '../../core/types.js';
import type { ResourceActivityTracker } from '../../core/resource/activity.js';

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

export interface ResourceAdmissionConfig {
  minMemAvailableMB: number;
  maxSubagents: number;
  lowMemoryRetryAfterMs: number;
  busyGpuRetryAfterMs: number;
}

export interface ResourceAdmissionControllerOptions {
  probe: ResourceProbe;
  activity: ResourceActivityTracker;
  config: ResourceAdmissionConfig;
}

/** 资源检查与槽位预留串行化，防止两个并发工具同时读到“还有一个槽位”。 */
export class ResourceAdmissionController implements AdmissionController {
  readonly #probe: ResourceProbe;
  readonly #activity: ResourceActivityTracker;
  readonly #config: ResourceAdmissionConfig;
  readonly #leases = new Set<() => void>();
  #gate: Promise<void> = Promise.resolve();

  constructor(options: ResourceAdmissionControllerOptions) {
    validateConfig(options.config);
    this.#probe = options.probe;
    this.#activity = options.activity;
    this.#config = { ...options.config };
  }

  async canSpawnSubagent(): Promise<AdmissionDecision> {
    let unlock = (): void => undefined;
    const previous = this.#gate;
    this.#gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;
    try {
      const snapshot = await this.#probe.snapshot();
      if (snapshot.memAvailableMB < this.#config.minMemAvailableMB) {
        return {
          ok: false,
          reason: `Available memory ${snapshot.memAvailableMB}MB is below the ${this.#config.minMemAvailableMB}MB subagent threshold.`,
          retryAfterMs: this.#config.lowMemoryRetryAfterMs,
        };
      }
      if (snapshot.activeSubagents >= this.#config.maxSubagents) {
        return {
          ok: false,
          reason: `The ${this.#config.maxSubagents} subagent limit is already in use.`,
          retryAfterMs: null,
        };
      }
      if (snapshot.gpuBusy && snapshot.activeSubagents >= 1) {
        return {
          ok: false,
          reason: 'GPU inference is busy and another subagent is already running.',
          retryAfterMs: this.#config.busyGpuRetryAfterMs,
        };
      }
      const release = this.#activity.beginSubagent();
      this.#leases.add(release);
      return { ok: true };
    } finally {
      unlock();
    }
  }

  releaseSubagent(): void {
    const release = this.#leases.values().next().value as (() => void) | undefined;
    if (release === undefined) return;
    this.#leases.delete(release);
    release();
  }
}

function validateConfig(config: ResourceAdmissionConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`admission.${name} must be a non-negative integer`);
    }
  }
  if (config.minMemAvailableMB < 1 || config.maxSubagents < 1) {
    throw new Error('admission memory and subagent limits must be positive');
  }
}
