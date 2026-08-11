import { describe, expect, it } from 'vitest';
import type { Tool } from '../src/core/types.js';
import { ToolRegistry } from '../src/core/tools/registry.js';

describe('ToolRegistry', () => {
  it('registers tools and exposes definitions without execute methods', () => {
    const tool = fakeTool('read');
    const registry = new ToolRegistry([tool]);

    expect(registry.get('read')).toBe(tool);
    expect(registry.definitions()).toEqual([
      {
        name: 'read',
        description: 'read tool',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
        concurrencySafe: true,
      },
    ]);
    expect(registry.definitions()[0]).not.toHaveProperty('execute');
    expect(registry.definitions()[0]).not.toHaveProperty('prepareSandbox');
  });

  it('rejects duplicate and invalid names', () => {
    const registry = new ToolRegistry([fakeTool('read')]);
    expect(() => registry.register(fakeTool('read'))).toThrow(
      'Duplicate tool name: read',
    );
    expect(() => registry.register(fakeTool('Bad Name'))).toThrow(
      'Invalid tool name: Bad Name',
    );
  });
});

function fakeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    concurrencySafe: true,
    prepareSandbox: (args) => ({ allowed: true, args }),
    execute: async () => ({ content: [], isError: false }),
  };
}
