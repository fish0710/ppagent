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
  passthroughPrepare,
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

  it('requires an explicit sandbox preparation contract at runtime', async () => {
    const execute = vi.fn(async () => textOutput('should not run'));
    // 模拟绕过 TypeScript 的动态 JS/MCP 工具，运行时边界仍要给出准确诊断。
    const dynamicTool = {
      name: 'dynamic',
      description: 'A dynamically registered tool.',
      parameters: { type: 'object', additionalProperties: false },
      execute,
    } as unknown as Tool;

    const output = await executeTool(
      dynamicTool,
      {},
      CONTEXT,
      {
        admission: new StubAdmissionController(),
        permissions: new StubPermissionPolicy(),
        sandbox: new PassthroughSandbox(),
      },
      OPTIONS,
    );

    expect(output).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: 'Tool dynamic does not implement prepareSandbox.',
        },
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets pure tools explicitly opt into passthrough preparation', async () => {
    const execute = vi.fn(async () => textOutput('computed'));
    const pureTool: Tool = {
      name: 'pure',
      description: 'Compute without filesystem or process access.',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      prepareSandbox: passthroughPrepare,
      execute,
    };

    const output = await executeTool(
      pureTool,
      { value: 'ok' },
      CONTEXT,
      {
        admission: new StubAdmissionController(),
        permissions: new StubPermissionPolicy(),
        sandbox: new PassthroughSandbox(),
      },
      OPTIONS,
    );

    expect(output).toEqual({
      isError: false,
      content: [{ type: 'text', text: 'computed' }],
    });
    expect(execute).toHaveBeenCalledWith(
      { value: 'ok' },
      expect.objectContaining({ cwd: CONTEXT.cwd }),
    );
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

    const outcome = await executeToolCall(
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

    expect(outcome.message).toMatchObject({
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

  // describe() 成功时 detail 只是把同一件事再用 JSON 说一遍——确认弹窗里
  // 「git status」旁边挂个 {"cmd":"git status"}，write 更糟：整份文件内容都会
  // 被塞进弹窗。只有摘要退回通用模板、用户无从判断要批准什么时它才有用。
  it('omits the raw-argument detail when the tool can describe itself', async () => {
    const check = vi.fn(async () => 'allow' as const);
    const described: Tool = {
      ...orderedTool([]),
      requiresAdmission: false,
      describe: (args) => `run ${(args as { value: string }).value}`,
    };
    await executeTool(described, { value: 'ok' }, CONTEXT, deps({ permissions: { check } }), OPTIONS);
    expect(check).toHaveBeenCalledWith(
      { toolName: 'ordered', summary: 'run ok' },
      INTERACTION,
    );
  });

  it('falls back to raw arguments when describe is absent, so the prompt still says what it approves', async () => {
    const check = vi.fn(async () => 'allow' as const);
    const opaque: Tool = { ...orderedTool([]), requiresAdmission: false };
    await executeTool(opaque, { value: 'ok' }, CONTEXT, deps({ permissions: { check } }), OPTIONS);
    expect(check).toHaveBeenCalledWith(
      {
        toolName: 'ordered',
        summary: 'Execute privileged tool ordered',
        detail: '{"value":"ok"}',
      },
      INTERACTION,
    );
  });

  it('does not ask twice when one privileged approval also covers an escalatable path', async () => {
    const check = vi.fn(async () => 'allow' as const);
    const execute = vi.fn(async () => textOutput('allowed once'));
    const tool: Tool = {
      ...orderedTool([]),
      prepareSandbox: () => ({
        allowed: false,
        reason: 'outside workspace',
        escalatable: true,
      }),
      execute,
    };

    const output = await executeTool(
      tool,
      { value: 'ok' },
      CONTEXT,
      {
        admission: new StubAdmissionController(),
        permissions: { check },
        sandbox: new PassthroughSandbox(),
      },
      OPTIONS,
    );

    expect(check).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      { value: 'ok' },
      expect.objectContaining({ cwd: CONTEXT.cwd }),
    );
    expect(output).toMatchObject({ isError: false });
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
    const outcome = await executeToolCall(
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

    expect(outcome.message).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'ordered',
      truncated: true,
      durationMs: 7,
      timestamp: 107,
    });
  });
});

function deps(
  overrides: Partial<Parameters<typeof executeTool>[3]> = {},
): Parameters<typeof executeTool>[3] {
  return {
    admission: new StubAdmissionController(),
    permissions: new StubPermissionPolicy(),
    sandbox: new PassthroughSandbox(),
    ...overrides,
  };
}

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
