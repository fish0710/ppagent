import { describe, expect, it, vi } from 'vitest';
import { StubAdmissionController } from '../src/agent/admission/index.js';
import { StubPermissionPolicy } from '../src/agent/permissions/index.js';
import { FauxProvider, toolCallTurn } from '../src/core/llm/faux.js';
import { PassthroughSandbox } from '../src/core/sandbox/passthrough.js';
import type {
  Interaction,
  Tool,
  ToolCallBlock,
  ToolContext,
  TraceContext,
} from '../src/core/types.js';
import {
  executeTool,
  executeToolCall,
  textOutput,
} from '../src/core/tools/execute.js';
import { ToolRegistry } from '../src/core/tools/registry.js';

const TRACE: TraceContext = {
  traceId: 'trace',
  spanId: 'span',
  child(name) {
    return { ...this, spanId: name };
  },
};

const INTERACTION: Interaction = {
  confirm: async () => false,
  ask: async () => null,
  select: async () => null,
  notify: () => undefined,
};

const CONTEXT: ToolContext = {
  signal: new AbortController().signal,
  cwd: process.cwd(),
  trace: TRACE,
  interaction: INTERACTION,
};

const OPTIONS = { maxResultChars: 80, toolTimeoutMs: 1_000 };

describe('executeTool', () => {
  it('runs admission → permissions → sandbox → execute and truncates head/tail', async () => {
    const order: string[] = [];
    const tool = orderedTool(order);
    const output = await executeTool(
      tool,
      { value: 'ok' },
      CONTEXT,
      {
        admission: {
          async canSpawnSubagent() {
            order.push('admission');
            return { ok: true };
          },
        },
        permissions: {
          async check() {
            order.push('permissions');
            return 'allow';
          },
        },
        sandbox: new PassthroughSandbox(),
      },
      OPTIONS,
    );

    expect(order).toEqual(['admission', 'permissions', 'sandbox', 'execute']);
    expect(output.truncated).toBe(true);
    expect(output.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/^HEAD[\s\S]*\[\.\.\. \d+ 行已省略 \.\.\.\][\s\S]*TAIL$/u),
    });
    expect(
      output.content[0]?.type === 'text' ? output.content[0].text.length : Infinity,
    ).toBeLessThanOrEqual(OPTIONS.maxResultChars);
  });

  it('short-circuits on a configurable admission denial', async () => {
    const execute = vi.fn(async () => textOutput('should not run'));
    const tool = { ...orderedTool([]), execute };
    const admission = new StubAdmissionController({
      ok: false,
      reason: 'GPU is busy',
      retryAfterMs: null,
    });
    const output = await executeTool(
      tool,
      { value: 'ok' },
      CONTEXT,
      {
        admission,
        permissions: new StubPermissionPolicy('allow'),
        sandbox: new PassthroughSandbox(),
      },
      OPTIONS,
    );

    expect(output).toMatchObject({ isError: true });
    expect(output.content[0]).toMatchObject({
      text: 'Admission denied: GPU is busy Do not retry; use a serial approach.',
    });
    expect(execute).not.toHaveBeenCalled();

    admission.setDecision({ ok: true });
    expect(
      await executeTool(
        tool,
        { value: 'ok' },
        CONTEXT,
        {
          admission,
          permissions: new StubPermissionPolicy('allow'),
          sandbox: new PassthroughSandbox(),
        },
        OPTIONS,
      ),
    ).toMatchObject({ isError: false });
  });

  it('returns malformed faux arguments as a tool error instead of throwing', async () => {
    const provider = new FauxProvider({
      turns: [toolCallTurn({ name: 'ordered', rawArguments: '{"value":' })],
    });
    let call: ToolCallBlock | undefined;
    for await (const event of provider.stream(provider.listModels()[0]!, {
      messages: [],
    })) {
      if (event.type === 'toolcall_end') call = event.call;
    }
    if (call === undefined) throw new Error('Expected faux tool call');
    expect(typeof call.arguments).toBe('string');

    const result = await executeToolCall(
      new ToolRegistry([orderedTool([])]),
      call,
      CONTEXT,
      {
        admission: new StubAdmissionController(),
        permissions: new StubPermissionPolicy(),
        sandbox: new PassthroughSandbox(),
      },
      OPTIONS,
    );

    expect(result).toMatchObject({
      role: 'toolResult',
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Invalid arguments for tool ordered: $ must be an object; received string',
        },
      ],
    });
  });

  it('short-circuits when permission or sandbox denies execution', async () => {
    const tool = orderedTool([]);
    const denied = await executeTool(
      tool,
      { value: 'ok' },
      CONTEXT,
      {
        admission: new StubAdmissionController(),
        permissions: new StubPermissionPolicy('deny'),
        sandbox: new PassthroughSandbox(),
      },
      OPTIONS,
    );
    expect(denied).toMatchObject({ isError: true });

    const hardSandboxTool: Tool = {
      ...tool,
      privileged: false,
      prepareSandbox: () => ({
        allowed: false,
        reason: 'outside workspace',
        escalatable: false,
      }),
    };
    const sandboxDenied = await executeTool(
      hardSandboxTool,
      { value: 'ok' },
      CONTEXT,
      {
        admission: new StubAdmissionController(),
        permissions: new StubPermissionPolicy(),
        sandbox: new PassthroughSandbox(),
      },
      OPTIONS,
    );
    expect(sandboxDenied.content[0]).toMatchObject({
      text: 'Sandbox denied tool execution: outside workspace',
    });
  });

  it('turns execution exceptions and timeouts into tool errors', async () => {
    const throwing: Tool = {
      ...orderedTool([]),
      requiresAdmission: false,
      privileged: false,
      execute: async () => {
        throw new Error('boom');
      },
    };
    const deps = {
      admission: new StubAdmissionController(),
      permissions: new StubPermissionPolicy(),
      sandbox: new PassthroughSandbox(),
    };
    expect(
      await executeTool(throwing, { value: 'ok' }, CONTEXT, deps, OPTIONS),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'Tool execution failed: boom' }],
    });

    const hanging: Tool = {
      ...throwing,
      // 故意忽略 AbortSignal；执行器本身仍必须按时返回。
      execute: async () => new Promise(() => undefined),
    };
    expect(
      await executeTool(hanging, { value: 'ok' }, CONTEXT, deps, {
        ...OPTIONS,
        toolTimeoutMs: 5,
      }),
    ).toMatchObject({
      isError: true,
      content: [{ text: 'Tool timed out after 5 ms.' }],
    });
  });

  it('propagates truncated: true to the tool-result message', async () => {
    const result = await executeToolCall(
      new ToolRegistry([orderedTool([])]),
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'ordered',
        arguments: { value: 'ok' },
      },
      CONTEXT,
      {
        admission: new StubAdmissionController(),
        permissions: new StubPermissionPolicy(),
        sandbox: new PassthroughSandbox(),
      },
      { ...OPTIONS, now: sequentialNow(100, 107) },
    );

    expect(result).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'ordered',
      truncated: true,
      durationMs: 7,
      timestamp: 107,
    });
  });
});

function orderedTool(order: string[]): Tool {
  return {
    name: 'ordered',
    description: 'exercise the complete chain',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    requiresAdmission: true,
    privileged: true,
    concurrencySafe: false,
    prepareSandbox(args) {
      order.push('sandbox');
      return { allowed: true, args };
    },
    async execute() {
      order.push('execute');
      return textOutput(`HEAD${'line\n'.repeat(100)}TAIL`);
    },
  };
}

function sequentialNow(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}
