import { describe, expect, it } from 'vitest';
import { StructuralSummarizer } from '../src/core/context/compact.js';
import { formatFileOperations } from '../src/core/context/files.js';
import { O200kTokenCounter } from '../src/core/context/tokenizer.js';
import { FauxProvider, textTurn, toolCallTurn } from '../src/core/llm/faux.js';
import { COMPACT_INSTRUCTION, LlmSummarizer } from '../src/agent/summarize/llm.js';
import type {
  FileOperations,
  Message,
  ModelRef,
  Provider,
  ReadonlyContext,
  StreamEvent,
  StreamOptions,
  SummarizeRequest,
  ToolDef,
  TraceContext,
} from '../src/core/types.js';

const counter = new O200kTokenCounter();

const MODEL: ModelRef = {
  provider: 'faux',
  id: 'faux-model',
  contextWindow: 32_768,
  maxOutputTokens: 4_096,
  supportsNativeToolCalling: true,
  supportsThinking: true,
};

const TOOLS: ToolDef[] = [
  {
    name: 'read',
    description: 'read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
];

/** 一份格式完整的模型响应，覆盖指令要求它写的全部段。 */
const FULL_MODEL_TURN = `## Goal
add retries to the network layer

## Next steps
write tests for the retry helper

## Facts to carry forward
retry lives in src/fetch.ts:retryFetch

## Done
implemented exponential backoff in src/fetch.ts

## New constraints
- must log every retry attempt

## New decisions
- cap retries at 3: avoids infinite loops on persistent failures`;

describe('LLM summarizer', () => {
  it('sends the live context verbatim plus one instruction so the prefix cache hits', async () => {
    const recorder = new RecordingProvider(
      new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] }),
    );
    const request = summarizeRequest();
    await summarizer(recorder).summarize(request);

    expect(recorder.calls).toHaveLength(1);
    const call = recorder.calls[0];

    // 前缀必须逐字节等于实活上下文，否则本地服务的 KV 前缀缓存全部作废。
    const live: Message[] = [
      request.previousSummary as Message,
      ...(request.carried ?? []),
      ...request.messages,
      ...(request.retained ?? []),
    ];
    expect(call?.context.messages.slice(0, live.length)).toEqual(live);
    expect(call?.context.messages).toHaveLength(live.length + 1);
    expect(call?.context.messages.at(-1)).toMatchObject({
      role: 'user',
      content: COMPACT_INSTRUCTION,
    });

    // 少传 tools 或改 systemPrompt 都会改变 chat template 渲染出的 prompt 前缀。
    expect(call?.context.systemPrompt).toBe(request.systemPrompt);
    expect(call?.context.tools).toEqual(TOOLS);
    expect(call?.options?.temperature).toBe(0);
  });

  it('produces a user-role summary and reports exactly one model call', async () => {
    const provider = new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] });
    const result = await summarizer(provider).summarize(summarizeRequest());

    expect(result.summary.role).toBe('user');
    expect(text(result.summary)).toContain('add retries to the network layer');
    expect(result.meta.strategy).toBe('llm');
    expect(result.meta.modelCalls).toBe(1);
  });

  it('carries forward constraints and decisions from the old summary and appends new ones without duplicating', async () => {
    const provider = new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] });
    const result = await summarizer(provider).summarize(summarizeRequest());
    const body = text(result.summary);

    // 已记录的（来自旧摘要）与新出现的（来自模型这一轮）必须都在，且各出现一次。
    expect(occurrences(body, 'do not introduce new dependencies')).toBe(1);
    expect(occurrences(body, 'must log every retry attempt')).toBe(1);
    expect(occurrences(body, 'use exponential backoff')).toBe(1);
    expect(occurrences(body, 'cap retries at 3')).toBe(1);
  });

  it('does not re-ask the model to repeat constraints or decisions it already recorded', async () => {
    const provider = new FauxProvider({
      // 模型只字未提旧约束/决策 —— 应该完全靠搬运存活，而不是靠模型重复。
      turns: [textTurn('## Goal\nship it\n\n## Next steps\nkeep going')],
    });
    const result = await summarizer(provider).summarize(summarizeRequest());
    const body = text(result.summary);
    expect(body).toContain('do not introduce new dependencies');
    expect(body).toContain('use exponential backoff');
  });

  it('replaces the previous summary instead of nesting it', async () => {
    const provider = new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] });
    const request = summarizeRequest();
    const result = await summarizer(provider).summarize(request);

    // 上一版摘要本身带着标记；新摘要是重新拼装的结果，不能把整块旧包装嵌进去。
    expect(text(request.previousSummary)).toContain('<compacted-session-summary>');
    expect(occurrences(text(result.summary), '<compacted-session-summary>')).toBe(1);
    // 旧摘要的 Goal 已被这一轮的 Goal 取代，不应该原样出现。
    expect(text(result.summary)).not.toContain('add retries to the network layer\n\nadd retries');
  });

  it('renders the harness-computed file list even though the model was never asked for one', async () => {
    const provider = new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] });
    const fileOps: FileOperations = {
      readFiles: ['src/other.ts'],
      modifiedFiles: ['src/fetch.ts'],
    };
    const result = await summarizer(provider).summarize({
      ...summarizeRequest(),
      fileOps,
    });
    expect(text(result.summary)).toContain(formatFileOperations(fileOps));
  });

  it('does not let a model-fabricated file list stand in for the harness-computed one', async () => {
    const provider = new FauxProvider({
      turns: [
        textTurn(
          '## Goal\nship it\n\n## Facts to carry forward\nsee below\n\n<files-read>\nfake-file-the-model-made-up.ts\n</files-read>',
        ),
      ],
    });
    const fileOps: FileOperations = { readFiles: ['src/real.ts'], modifiedFiles: [] };
    const result = await summarizer(provider).summarize({
      ...summarizeRequest(),
      fileOps,
    });
    // 唯一权威的文件清单块必须来自 harness 计算值，不管模型写了什么。
    expect(text(result.summary)).toContain(formatFileOperations(fileOps));
  });

  it('degrades when a text-form tool call is embedded inside an otherwise well-formed section', async () => {
    // sawToolCall 只覆盖原生 toolcall_end 事件；模型把工具调用当纯文本写进
    // 正文（<tool_call> 标签）时文本非空、格式看起来也合法，之前会被直接收下。
    const provider = new FauxProvider({
      turns: [
        textTurn(
          '## Goal\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>\n\n## Next steps\nkeep going',
        ),
      ],
    });
    const warnings: string[] = [];
    const result = await summarizer(provider, warnings).summarize(summarizeRequest());
    expect(result.meta.strategy).toBe('llm-fallback-structural');
    expect(warnings[0]).toContain('伪装成了纯文本');
  });

  it('degrades instead of guessing when the model text has no recognizable section headings', async () => {
    // 模型完全无视格式，写了一段自由散文；宁可整体降级，也不猜它属于哪一段。
    const provider = new FauxProvider({
      turns: [textTurn('Sure! I refactored the fetch helper and added retries.')],
    });
    const warnings: string[] = [];
    const result = await summarizer(provider, warnings).summarize(summarizeRequest());
    expect(result.meta.strategy).toBe('llm-fallback-structural');
    expect(warnings[0]).toContain('分段标题');
  });

  it('falls back to the rule-based summarizer when the model only calls tools', async () => {
    const provider = new FauxProvider({
      turns: [toolCallTurn({ name: 'read', rawArguments: '{"path":"a.ts"}' })],
    });
    const warnings: string[] = [];
    const result = await summarizer(provider, warnings).summarize(summarizeRequest());

    expect(result.meta.strategy).toBe('llm-fallback-structural');
    expect(result.meta.modelCalls).toBe(1);
    expect(text(result.summary)).toContain('Compacted conversation history:');
    expect(warnings).toHaveLength(1);
  });

  it('falls back when the model returns nothing', async () => {
    const provider = new FauxProvider({ turns: [textTurn('   ')] });
    const result = await summarizer(provider).summarize(summarizeRequest());
    expect(result.meta.strategy).toBe('llm-fallback-structural');
  });

  it('falls back when the provider ends the stream with an error event', async () => {
    // provider 以事件收尾而非抛异常；不显式消费就会当成"模型没说话"。
    const provider = new FauxProvider({
      turns: [{ steps: [{ type: 'throw', message: 'connection refused' }] }],
    });
    const warnings: string[] = [];
    const result = await summarizer(provider, warnings).summarize(summarizeRequest());

    expect(result.meta.strategy).toBe('llm-fallback-structural');
    expect(warnings[0]).toContain('connection refused');
  });

  it('falls back when the summary call outruns its own timeout', async () => {
    const provider = new FauxProvider({
      turns: [{ steps: [{ type: 'delay', ms: 5_000 }, { type: 'text_delta', delta: 'x' }] }],
    });
    const result = await summarizer(provider, [], { timeoutMs: 5 }).summarize(
      summarizeRequest(),
    );
    expect(result.meta.strategy).toBe('llm-fallback-structural');
  });

  it('rethrows on user cancellation rather than quietly degrading', async () => {
    const provider = new FauxProvider({ turns: [textTurn(FULL_MODEL_TURN)] });
    const controller = new AbortController();
    controller.abort(new Error('user pressed ctrl-c'));
    const warnings: string[] = [];

    await expect(
      summarizer(provider, warnings).summarize({
        ...summarizeRequest(),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    // 降级会让 Ctrl+C 之后还继续跑一段活。
    expect(warnings).toHaveLength(0);
  });

  it('truncates only the Done section when over budget, leaving decisions/facts/files intact', async () => {
    const hugeDone = 'finished step. '.repeat(2_000);
    const provider = new FauxProvider({
      turns: [
        textTurn(
          `## Goal\nship it\n\n## Next steps\nkeep going\n\n## Facts to carry forward\nentrypoint is src/fetch.ts\n\n## Done\n${hugeDone}\n\n## New decisions\n- cap retries at 3: avoids infinite loops`,
        ),
      ],
    });
    const fileOps: FileOperations = { readFiles: [], modifiedFiles: ['src/fetch.ts'] };
    const result = await summarizer(provider).summarize({
      ...summarizeRequest(),
      fileOps,
      targetTokens: 300,
    });
    const body = text(result.summary);

    expect(counter.countText(body)).toBeLessThanOrEqual(300);
    // 最不能丢的几段必须完好：搬运的约束/决策、这一轮的新决策、事实、文件清单。
    expect(body).toContain('do not introduce new dependencies');
    expect(body).toContain('use exponential backoff');
    expect(body).toContain('cap retries at 3');
    expect(body).toContain('entrypoint is src/fetch.ts');
    expect(body).toContain(formatFileOperations(fileOps));
    // 唯一被砍的是 Done 的正文。
    expect(body).not.toContain(hugeDone);
  });
});

function summarizer(
  provider: Provider,
  warnings: string[] = [],
  overrides: { timeoutMs?: number } = {},
): LlmSummarizer {
  return new LlmSummarizer({
    provider,
    model: MODEL,
    tokenCounter: counter,
    fallback: new StructuralSummarizer({ tokenCounter: counter }),
    maxTokens: 2_048,
    timeoutMs: overrides.timeoutMs ?? 30_000,
    notify: (message) => warnings.push(message),
  });
}

function summarizeRequest(): SummarizeRequest {
  return {
    previousSummary: {
      role: 'user',
      content: [
        '以下是此前对话被压缩后的摘要，它已取代压缩点之前的全部原始消息。基于它继续工作，不要重复已经完成的工作。',
        '',
        '<compacted-session-summary>',
        '## Goal',
        'add retries to the network layer',
        '',
        '## Constraints & preferences',
        '- do not introduce new dependencies',
        '- must support Node 22',
        '',
        '## Next steps',
        'investigate flaky test failures',
        '',
        '## Key decisions',
        '- use exponential backoff: avoids thundering herd on retries',
        '',
        '## Facts to carry forward',
        'entrypoint is src/fetch.ts',
        '</compacted-session-summary>',
      ].join('\n'),
      timestamp: 1,
    },
    // 上一次压缩保留下来的 user 消息块，紧跟在 previousSummary 之后。
    carried: [
      { role: 'user', content: 'please keep the API backward compatible', timestamp: 2 },
    ],
    messages: [
      { role: 'user', content: 'add a retry to the fetch helper', timestamp: 3 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'looking at src/fetch.ts' }],
        stopReason: 'stop',
        usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
        timestamp: 4,
      },
    ],
    retained: [{ role: 'user', content: 'also add a test', timestamp: 5 }],
    systemPrompt: 'you are a coding agent',
    tools: TOOLS,
    targetTokens: 2_048,
    signal: new AbortController().signal,
    trace: TRACE,
  };
}

/** 捕获真正发出去的请求；FauxProvider 本身忽略 context。 */
class RecordingProvider implements Provider {
  readonly calls: { context: ReadonlyContext; options?: StreamOptions }[] = [];
  readonly #inner: Provider;

  constructor(inner: Provider) {
    this.#inner = inner;
  }

  get id(): string {
    return this.#inner.id;
  }

  listModels(): ModelRef[] {
    return this.#inner.listModels();
  }

  stream(
    model: ModelRef,
    context: ReadonlyContext,
    options?: StreamOptions,
  ): AsyncIterable<StreamEvent> {
    this.calls.push({
      context: structuredClone({
        ...(context.systemPrompt === undefined
          ? {}
          : { systemPrompt: context.systemPrompt }),
        messages: [...context.messages],
        ...(context.tools === undefined ? {} : { tools: [...context.tools] }),
      }),
      ...(options === undefined ? {} : { options }),
    });
    return this.#inner.stream(model, context, options);
  }
}

function text(message: Message | undefined): string {
  return message?.role === 'user' && typeof message.content === 'string'
    ? message.content
    : '';
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const TRACE: TraceContext = {
  traceId: 'trace',
  spanId: 'span',
  child(name) {
    return { ...this, spanId: name };
  },
};
