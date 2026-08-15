import { freemem, totalmem } from 'node:os';
import type { ResourceProbe, ResourceSnapshot } from '../types.js';
import type { ResourceActivityTracker } from './activity.js';

/** 非 macOS 的无命令回退；保持同一接口但不伪装成平台压力指标。 */
export class SystemResourceProbe implements ResourceProbe {
  readonly #activity: ResourceActivityTracker;
  readonly #now: () => number;

  constructor(activity: ResourceActivityTracker, now: () => number = Date.now) {
    this.#activity = activity;
    this.#now = now;
  }

  async snapshot(): Promise<ResourceSnapshot> {
    const total = totalmem();
    const available = freemem();
    return {
      source: 'system',
      memPressure: total === 0 ? 1 : Math.min(1, Math.max(0, 1 - available / total)),
      memAvailableMB: Math.round((available / (1024 * 1024)) * 10) / 10,
      gpuBusy: this.#activity.activeInference > 0,
      activeSubagents: this.#activity.activeSubagents,
      sampledAt: this.#now(),
    };
  }
}
