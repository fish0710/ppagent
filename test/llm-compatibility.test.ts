import { describe, expect, it } from 'vitest';
import { validateNativeToolCalling } from '../src/core/llm/compatibility.js';
import {
  FauxProvider,
  textTurn,
  toolCallTurn,
} from '../src/core/llm/faux.js';

describe('native tool compatibility probe', () => {
  it('accepts a matching native streamed tool call', async () => {
    const provider = new FauxProvider({
      turns: [
        toolCallTurn({
          id: 'compat-call',
          name: 'ppagent_compat_probe',
          rawArguments: '{"token":"probe-token"}',
          argumentChunkSize: 1,
        }),
      ],
    });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');

    await expect(
      validateNativeToolCalling(provider, model, { token: 'probe-token' }),
    ).resolves.toMatchObject({
      ok: true,
      stopReason: 'toolUse',
      call: { id: 'compat-call', name: 'ppagent_compat_probe' },
      errors: [],
    });
  });

  it('rejects a text-only response even when the model claims native support', async () => {
    const provider = new FauxProvider({ turns: [textTurn('{"name":"ppagent_compat_probe"}')] });
    const model = provider.listModels()[0];
    if (model === undefined) throw new Error('Missing faux model');

    const report = await validateNativeToolCalling(provider, model);
    expect(report.ok).toBe(false);
    expect(report.errors).toContain('Expected stopReason toolUse, received stop.');
    expect(report.errors).toContain('Expected one native streamed tool call, received 0.');
  });
});
