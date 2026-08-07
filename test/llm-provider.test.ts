import { describe, expect, it } from 'vitest';
import type { ModelRef } from '../src/core/types.js';
import {
  createErrorMessage,
  emptyUsage,
  findModel,
  isTerminalEvent,
  modelOrigin,
} from '../src/core/llm/provider.js';

const MODEL: ModelRef = {
  provider: 'test',
  id: 'same-name',
  contextWindow: 1_000,
  maxOutputTokens: 100,
  supportsNativeToolCalling: true,
  supportsThinking: false,
};

describe('LLM provider helpers', () => {
  it('matches a model by both provider and id', () => {
    const other = { ...MODEL, provider: 'other' };
    expect(findModel([other, MODEL], 'test', 'same-name')).toEqual(MODEL);
    expect(findModel([other], 'test', 'same-name')).toBeUndefined();
  });

  it('creates a serializable error message with origin', () => {
    const message = createErrorMessage('boom', {
      origin: modelOrigin(MODEL),
      now: () => 123,
    });
    expect(message).toEqual({
      role: 'assistant',
      content: [],
      stopReason: 'error',
      usage: emptyUsage(),
      origin: { provider: 'test', model: 'same-name' },
      errorMessage: 'boom',
      timestamp: 123,
    });
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it('recognizes both terminal event variants', () => {
    const message = createErrorMessage('boom');
    expect(isTerminalEvent({ type: 'start' })).toBe(false);
    expect(isTerminalEvent({ type: 'done', message })).toBe(true);
    expect(
      isTerminalEvent({ type: 'error', reason: 'error', message }),
    ).toBe(true);
  });
});
