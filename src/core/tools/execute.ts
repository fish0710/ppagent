import type {
  AdmissionController,
  PermissionPolicy,
  PermissionRequest,
  Sandbox,
  Tool,
  ToolCallBlock,
  ToolContext,
  ToolOutput,
  ToolResultMessage,
} from '../types.js';
import { ToolRegistry } from './registry.js';
import { validateArguments } from './validate.js';

export interface ToolExecutorDeps {
  admission: AdmissionController;
  permissions: PermissionPolicy;
  sandbox: Sandbox;
}

export interface ToolExecutorOptions {
  maxResultChars: number;
  toolTimeoutMs: number;
  now?: () => number;
}

/**
 * 纯计算工具可显式使用这个准备器，表示它确认不需要路径检查或命令包装。
 * prepareSandbox 仍保持必填，避免“忘记声明安全策略”等同于默认放行。
 */
export const passthroughPrepare: Tool['prepareSandbox'] = (args) => ({
  allowed: true,
  args,
});

export async function executeTool(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  deps: ToolExecutorDeps,
  options: ToolExecutorOptions,
): Promise<ToolOutput> {
  const finish = (output: ToolOutput): ToolOutput =>
    truncateOutput(output, options.maxResultChars);
  const validated = validateArguments(tool.parameters, args);
  if (!validated.ok) {
    return finish(
      errorOutput(
        `Invalid arguments for tool ${tool.name}: ${validated.errors.join('; ')}`,
      ),
    );
  }

  // Tool 是 TypeScript 契约，但动态注册的 JS/MCP 工具仍需要运行时边界检查。
  if (typeof tool.prepareSandbox !== 'function') {
    return finish(
      errorOutput(`Tool ${tool.name} does not implement prepareSandbox.`),
    );
  }

  let admissionReserved = false;
  if (tool.requiresAdmission === true) {
    const decision = await deps.admission.canSpawnSubagent();
    if (!decision.ok) {
      const retry =
        decision.retryAfterMs === undefined
          ? ''
          : decision.retryAfterMs === null
            ? ' Do not retry; use a serial approach.'
            : ` Retry after ${decision.retryAfterMs} ms.`;
      return finish(
        errorOutput(
          `Admission denied: ${decision.reason ?? 'resource limits'}${retry}`,
        ),
      );
    }
    admissionReserved = true;
  }

  try {
    let permissionGranted = false;
    if (tool.privileged === true) {
      const decision = await deps.permissions.check(
        permissionRequest(tool, validated.value),
        ctx.interaction,
      );
      if (decision === 'deny') {
        return finish(errorOutput('User denied tool execution.'));
      }
      permissionGranted = true;
    }

    let prepared;
    try {
      prepared = tool.prepareSandbox(validated.value, ctx, deps.sandbox);
    } catch (error) {
      return finish(
        errorOutput(`Sandbox preparation failed: ${errorMessage(error)}`),
      );
    }
    if (!prepared.allowed) {
      if (!prepared.escalatable) {
        return finish(
          errorOutput(`Sandbox denied tool execution: ${prepared.reason}`),
        );
      }
      if (!permissionGranted) {
        const decision = await deps.permissions.check(
          {
            ...permissionRequest(tool, validated.value),
            sandboxReason: prepared.reason,
          },
          ctx.interaction,
        );
        if (decision === 'deny') {
          return finish(errorOutput(`Sandbox exception denied: ${prepared.reason}`));
        }
      }
      prepared = { allowed: true, args: validated.value };
    }

    const raw = await runTool(tool, prepared.args, ctx, options.toolTimeoutMs);
    return finish(raw);
  } finally {
    if (admissionReserved) deps.admission.releaseSubagent?.();
  }
}

export async function executeToolCall(
  registry: ToolRegistry,
  call: ToolCallBlock,
  ctx: ToolContext,
  deps: ToolExecutorDeps,
  options: ToolExecutorOptions,
): Promise<ToolResultMessage> {
  const startedAt = (options.now ?? Date.now)();
  const tool = registry.get(call.name);
  const output =
    tool === undefined
      ? truncateOutput(
          errorOutput(`Unknown tool: ${call.name}`),
          options.maxResultChars,
        )
      : await executeTool(tool, call.arguments, ctx, deps, options);
  const endedAt = (options.now ?? Date.now)();
  return {
    role: 'toolResult',
    toolCallId: call.id,
    toolName: call.name,
    content: output.content,
    isError: output.isError,
    ...(output.truncated === true ? { truncated: true } : {}),
    durationMs: Math.max(0, endedAt - startedAt),
    timestamp: endedAt,
  };
}

export function errorOutput(message: string): ToolOutput {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function textOutput(text: string, isError = false): ToolOutput {
  return { content: [{ type: 'text', text }], isError };
}

export function truncateOutput(output: ToolOutput, maxChars: number): ToolOutput {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error('maxResultChars must be a positive integer');
  }
  let remaining = maxChars;
  let truncated = output.truncated === true;
  const content = output.content.map((block) => {
    if (block.type !== 'text') return block;
    if (block.text.length <= remaining) {
      remaining -= block.text.length;
      return block;
    }
    truncated = true;
    const text = truncateText(block.text, Math.max(1, remaining));
    remaining = 0;
    return { ...block, text };
  });
  return {
    ...output,
    content,
    ...(truncated ? { truncated: true } : {}),
  };
}

function truncateText(text: string, budget: number): string {
  const markerFor = (omittedLines: number): string =>
    `\n[... ${omittedLines} 行已省略 ...]\n`;
  let keep = Math.max(0, budget - markerFor(1).length);
  let headLength = Math.ceil(keep / 2);
  let tailLength = Math.floor(keep / 2);
  let omitted = text.slice(headLength, text.length - tailLength);
  let marker = markerFor(countLines(omitted));
  // 第一遍用占位行数估算 marker；第二遍按真实行数长度重新分配头尾预算。
  keep = Math.max(0, budget - marker.length);
  headLength = Math.ceil(keep / 2);
  tailLength = Math.floor(keep / 2);
  omitted = text.slice(headLength, text.length - tailLength);
  marker = markerFor(countLines(omitted));
  return `${text.slice(0, headLength)}${marker}${
    tailLength === 0 ? '' : text.slice(-tailLength)
  }`;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

async function runTool(
  tool: Tool,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<ToolOutput> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    return errorOutput('toolTimeoutMs must be a positive integer');
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = (): void => controller.abort(ctx.signal.reason);
  if (ctx.signal.aborted) controller.abort(ctx.signal.reason);
  else ctx.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Tool timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      controller.signal.addEventListener(
        'abort',
        () => reject(controller.signal.reason),
        { once: true },
      );
    });
    return await Promise.race([
      tool.execute(args, { ...ctx, signal: controller.signal }),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) return errorOutput(`Tool timed out after ${timeoutMs} ms.`);
    if (controller.signal.aborted) return errorOutput('Tool execution aborted.');
    return errorOutput(`Tool execution failed: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

function permissionRequest(tool: Tool, args: unknown): PermissionRequest {
  let summary = `Execute privileged tool ${tool.name}`;
  if (tool.describe !== undefined) {
    try {
      const described = tool.describe(args).trim();
      if (described.length > 0) summary = described;
    } catch {
      // 权限摘要失败不能绕过权限检查；退回保守模板。
    }
  }
  return {
    toolName: tool.name,
    summary,
    detail: safeStringify(args),
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
