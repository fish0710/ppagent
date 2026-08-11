import { describe, expect, it } from 'vitest';
import { validateArguments } from '../src/core/tools/validate.js';

const SCHEMA = {
  type: 'object' as const,
  properties: {
    path: { type: 'string' as const },
    count: { type: 'integer' as const },
    mode: { type: 'string' as const, enum: ['head', 'tail'] },
  },
  required: ['path'],
  additionalProperties: false,
};

describe('validateArguments', () => {
  it('accepts values matching the supported JSON Schema subset', () => {
    const args = { path: 'file.txt', count: 2, mode: 'head' };
    expect(validateArguments(SCHEMA, args)).toEqual({ ok: true, value: args });
  });

  it('reports type, required, enum and additional-property errors', () => {
    expect(
      validateArguments(SCHEMA, { count: 1.5, mode: 'middle', extra: true }),
    ).toEqual({
      ok: false,
      errors: [
        '$.path is required',
        '$.count must be an integer; received number',
        '$.mode must be one of ["head","tail"]',
        '$.extra is not allowed',
      ],
    });
  });

  it('keeps a malformed raw argument string on the validation path', () => {
    expect(validateArguments(SCHEMA, '{"path":')).toEqual({
      ok: false,
      errors: ['$ must be an object; received string'],
    });
  });
});
