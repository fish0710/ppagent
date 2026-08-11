import type { Tool, ToolDef } from '../types.js';

const TOOL_NAME = /^[a-z][a-z0-9_-]*$/u;

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: Iterable<Tool> = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    if (!TOOL_NAME.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (this.#tools.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  definitions(): ToolDef[] {
    return [...this.#tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.privileged === undefined ? {} : { privileged: tool.privileged }),
      ...(tool.requiresAdmission === undefined
        ? {}
        : { requiresAdmission: tool.requiresAdmission }),
      ...(tool.concurrencySafe === undefined
        ? {}
        : { concurrencySafe: tool.concurrencySafe }),
    }));
  }
}
