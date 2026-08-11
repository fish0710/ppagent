import type { Tool } from '../../types.js';
import { ToolRegistry } from '../registry.js';
import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { readTool } from './read.js';
import { writeTool } from './write.js';

export { bashTool, editTool, readTool, writeTool };

export function createBuiltinTools(): Tool[] {
  return [readTool, writeTool, editTool, bashTool];
}

export function createBuiltinToolRegistry(): ToolRegistry {
  return new ToolRegistry(createBuiltinTools());
}
