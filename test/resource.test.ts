import { describe, expect, it, vi } from 'vitest';
import { ResourceAdmissionController } from '../src/agent/admission/index.js';
import {
  MacOsResourceProbe,
  ResourceActivityTracker,
  parseMemoryPressure,
  parseVmStat,
} from '../src/core/resource/index.js';

describe('resource probes', () => {
  it('parses memory_pressure and vm_stat recordings', () => {
    expect(
      parseMemoryPressure(`The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 25%\n`),
    ).toEqual({ memPressure: 0.75, memAvailableMB: 4096 });

    expect(
      parseVmStat(`Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 100.\nPages active: 400.\nPages inactive: 200.\nPages speculative: 50.\nPages wired down: 200.\nPages purgeable: 50.\nPages occupied by compressor: 50.\n`),
    ).toEqual({ memPressure: 0.6, memAvailableMB: 6.3 });
  });

  const macIt = process.platform === 'darwin' ? it : it.skip;

  macIt('caches system sampling while keeping activity counters live', async () => {
    const activity = new ResourceActivityTracker();
    let now = 1_000;
    const run = vi.fn(async () => ({
      stdout:
        'The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 50%\n',
      stderr: '',
    }));
    const probe = new MacOsResourceProbe({
      activity,
      cacheMs: 2_000,
      now: () => now,
      run,
    });

    expect(await probe.snapshot()).toMatchObject({
      source: 'memory_pressure',
      memPressure: 0.5,
      memAvailableMB: 8192,
      gpuBusy: false,
      activeSubagents: 0,
      sampledAt: 1_000,
    });
    const releaseInference = activity.beginInference();
    const releaseSubagent = activity.beginSubagent();
    now = 2_000;
    expect(await probe.snapshot()).toMatchObject({
      gpuBusy: true,
      activeSubagents: 1,
      sampledAt: 1_000,
    });
    expect(run).toHaveBeenCalledOnce();
    releaseInference();
    releaseSubagent();
  });

  macIt('samples the real macOS host and exposes the active pressure source', async () => {
    const probe = new MacOsResourceProbe({
      activity: new ResourceActivityTracker(),
      cacheMs: 0,
    });

    const snapshot = await probe.snapshot();

    expect(['memory_pressure', 'vm_stat']).toContain(snapshot.source);
    expect(snapshot.memPressure).toBeGreaterThanOrEqual(0);
    expect(snapshot.memPressure).toBeLessThanOrEqual(1);
    expect(snapshot.memAvailableMB).toBeGreaterThanOrEqual(0);
    expect(snapshot.sampledAt).toBeGreaterThan(0);
  });
});

describe('ResourceAdmissionController', () => {
  it('serializes concurrent decisions and reserves/releases a slot atomically', async () => {
    const activity = new ResourceActivityTracker();
    const releaseInference = activity.beginInference();
    const probe = {
      async snapshot() {
        return {
          source: 'test' as const,
          memPressure: 0.2,
          memAvailableMB: 16_384,
          gpuBusy: activity.activeInference > 0,
          activeSubagents: activity.activeSubagents,
          sampledAt: Date.now(),
        };
      },
    };
    const admission = new ResourceAdmissionController({
      probe,
      activity,
      config: {
        minMemAvailableMB: 2_048,
        maxSubagents: 2,
        lowMemoryRetryAfterMs: 5_000,
        busyGpuRetryAfterMs: 10_000,
      },
    });

    const [first, second] = await Promise.all([
      admission.canSpawnSubagent(),
      admission.canSpawnSubagent(),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({
      ok: false,
      reason: expect.stringContaining('GPU inference is busy'),
      retryAfterMs: 10_000,
    });
    expect(activity.activeSubagents).toBe(1);
    admission.releaseSubagent();
    admission.releaseSubagent();
    expect(activity.activeSubagents).toBe(0);
    releaseInference();
  });

  it('returns an actionable low-memory denial', async () => {
    const activity = new ResourceActivityTracker();
    const admission = new ResourceAdmissionController({
      activity,
      probe: {
        async snapshot() {
          return {
            source: 'test' as const,
            memPressure: 0.95,
            memAvailableMB: 512,
            gpuBusy: false,
            activeSubagents: 0,
            sampledAt: 1,
          };
        },
      },
      config: {
        minMemAvailableMB: 2_048,
        maxSubagents: 2,
        lowMemoryRetryAfterMs: 5_000,
        busyGpuRetryAfterMs: 10_000,
      },
    });

    expect(await admission.canSpawnSubagent()).toEqual({
      ok: false,
      reason: 'Available memory 512MB is below the 2048MB subagent threshold.',
      retryAfterMs: 5_000,
    });
    expect(activity.activeSubagents).toBe(0);
  });
});
