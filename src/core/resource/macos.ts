import { execFile } from 'node:child_process';
import type { ResourceProbe, ResourceSnapshot } from '../types.js';
import type { ResourceActivityTracker } from './activity.js';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type ResourceCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<CommandResult>;

export interface MacOsResourceProbeOptions {
  activity: ResourceActivityTracker;
  cacheMs?: number;
  now?: () => number;
  run?: ResourceCommandRunner;
}

interface MemorySample {
  source: 'memory_pressure' | 'vm_stat';
  memPressure: number;
  memAvailableMB: number;
  sampledAt: number;
}

/** macOS 内存探针；昂贵的系统采样缓存，活动计数始终取实时值。 */
export class MacOsResourceProbe implements ResourceProbe {
  readonly #activity: ResourceActivityTracker;
  readonly #cacheMs: number;
  readonly #now: () => number;
  readonly #run: ResourceCommandRunner;
  #cached: MemorySample | undefined;
  #pending: Promise<MemorySample> | undefined;

  constructor(options: MacOsResourceProbeOptions) {
    if (process.platform !== 'darwin') {
      throw new Error('MacOsResourceProbe is only available on macOS');
    }
    this.#activity = options.activity;
    this.#cacheMs = options.cacheMs ?? 2_000;
    if (!Number.isInteger(this.#cacheMs) || this.#cacheMs < 0) {
      throw new Error('resource cacheMs must be a non-negative integer');
    }
    this.#now = options.now ?? Date.now;
    this.#run = options.run ?? runCommand;
  }

  async snapshot(): Promise<ResourceSnapshot> {
    const memory = await this.#memorySample();
    return {
      ...memory,
      // powermetrics 需要 sudo；活跃推理是无特权、可重复的保守软信号。
      gpuBusy: this.#activity.activeInference > 0,
      activeSubagents: this.#activity.activeSubagents,
    };
  }

  async #memorySample(): Promise<MemorySample> {
    const now = this.#now();
    if (this.#cached !== undefined && now - this.#cached.sampledAt < this.#cacheMs) {
      return this.#cached;
    }
    if (this.#pending !== undefined) return this.#pending;
    this.#pending = this.#sample(now);
    try {
      const sample = await this.#pending;
      this.#cached = sample;
      return sample;
    } finally {
      this.#pending = undefined;
    }
  }

  async #sample(sampledAt: number): Promise<MemorySample> {
    try {
      const result = await this.#run('/usr/bin/memory_pressure', ['-Q']);
      return {
        source: 'memory_pressure',
        ...parseMemoryPressure(result.stdout),
        sampledAt,
      };
    } catch {
      const result = await this.#run('/usr/bin/vm_stat', []);
      return { source: 'vm_stat', ...parseVmStat(result.stdout), sampledAt };
    }
  }
}

export function parseMemoryPressure(
  text: string,
): Omit<MemorySample, 'source' | 'sampledAt'> {
  const totalMatch = /system has\s+(\d+)\s*\(/iu.exec(text);
  const freeMatch = /memory free percentage:\s*(\d+(?:\.\d+)?)%/iu.exec(text);
  if (totalMatch?.[1] === undefined || freeMatch?.[1] === undefined) {
    throw new Error('Unrecognized memory_pressure output');
  }
  const totalBytes = Number(totalMatch[1]);
  const freeRatio = clamp(Number(freeMatch[1]) / 100);
  return {
    memPressure: clamp(1 - freeRatio),
    memAvailableMB: roundMB((totalBytes * freeRatio) / (1024 * 1024)),
  };
}

export function parseVmStat(
  text: string,
): Omit<MemorySample, 'source' | 'sampledAt'> {
  const pageSizeMatch = /page size of\s+(\d+)\s+bytes/iu.exec(text);
  if (pageSizeMatch?.[1] === undefined) {
    throw new Error('Unrecognized vm_stat page size');
  }
  const pageSize = Number(pageSizeMatch[1]);
  const fields = new Map<string, number>();
  for (const match of text.matchAll(/^([^:\n]+):\s+(\d+)\.?$/gmu)) {
    const name = match[1]?.trim();
    const pages = match[2];
    if (name !== undefined && pages !== undefined) fields.set(name, Number(pages));
  }
  const freePages = sum(fields, [
    'Pages free',
    'Pages inactive',
    'Pages speculative',
    'Pages purgeable',
  ]);
  const residentPages = sum(fields, [
    'Pages free',
    'Pages active',
    'Pages inactive',
    'Pages speculative',
    'Pages wired down',
    'Pages occupied by compressor',
  ]);
  if (residentPages <= 0) throw new Error('Unrecognized vm_stat page counters');
  return {
    memPressure: clamp(1 - freePages / residentPages),
    memAvailableMB: roundMB((freePages * pageSize) / (1024 * 1024)),
  };
}

function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`${command} failed: ${stderr.trim() || error.message}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function sum(values: ReadonlyMap<string, number>, names: readonly string[]): number {
  return names.reduce((total, name) => total + (values.get(name) ?? 0), 0);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundMB(value: number): number {
  return Math.round(value * 10) / 10;
}
