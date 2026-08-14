import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FauxProvider,
  createPiAiProvider,
  findModel,
  isTerminalEvent,
  textTurn,
  toolCallTurn,
  type Context,
  type ModelRef,
  type Provider,
} from '../dist/core/llm/index.js';
import {
  StructuralSummarizer,
  ThresholdCompactPolicy,
  O200kTokenCounter,
} from '../dist/core/context/index.js';
import {
  runAgentLoop,
  type AgentLoopPersistence,
} from '../dist/core/loop/index.js';
import {
  JsonlStore,
  latestCompaction,
  replay,
} from '../dist/core/store/index.js';
import {
  ConsoleSpanExporter,
  createTraceContext,
} from '../dist/core/telemetry/index.js';
import { StubAdmissionController } from '../dist/agent/admission/index.js';
import { StubPermissionPolicy } from '../dist/agent/permissions/index.js';
import { PassthroughSandbox } from '../dist/core/sandbox/index.js';
import {
  createBuiltinToolRegistry,
  executeToolCall,
} from '../dist/core/tools/index.js';
import type {
  CompactResult,
  Interaction,
  Message,
  StoreRecord,
  ToolContext,
  UIEvent,
} from '../dist/core/types.js';
import { readCustomSmokeEnvironment } from './smoke-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
) as { name: string; version: string };

interface SmokeArgs {
  provider: string;
  model?: string;
  prompt: string;
}

interface ToolArgs {
  name: string;
  arguments: unknown;
}

interface AgentArgs extends SmokeArgs {
  maxTurns: number;
  maxTokens?: number;
  session?: string;
  resume: boolean;
  trace: boolean;
}

function printVersion(): void {
  process.stdout.write(`${pkg.name} ${pkg.version}\n`);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  agent --version
  agent [--provider faux|anthropic|openai|custom] [--model MODEL] [--max-turns N]
        [--max-tokens N] [--session ID] [--resume] [--trace] PROMPT
  agent --smoke [--provider faux|anthropic|openai|custom] [--model MODEL] [PROMPT]
  agent --tool read|write|edit|bash [--args JSON]

Custom provider environment:
  PPAGENT_CUSTOM_BASE_URL  OpenAI-compatible API root, usually ending in /v1
  PPAGENT_CUSTOM_API_KEY   Optional; omit it for services without authentication
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--version') || args.includes('-v')) {
    printVersion();
    return;
  }
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (args.includes('--tool')) {
    await runTool(parseToolArgs(args));
    return;
  }
  if (args.includes('--smoke')) {
    await runSmoke(parseSmokeArgs(args));
    return;
  }
  await runAgent(parseAgentArgs(args));
}

async function runSmoke(smokeArgs: SmokeArgs): Promise<void> {
  const { provider, model } = createSmokeProvider(smokeArgs);
  const context: Context = {
    messages: [
      { role: 'user', content: smokeArgs.prompt, timestamp: Date.now() },
    ],
  };

  let terminal = false;
  let wroteText = false;
  for await (const event of provider.stream(model, context)) {
    switch (event.type) {
      case 'start':
      case 'toolcall_start':
      case 'toolcall_delta':
        break;
      case 'text_delta':
        wroteText = true;
        process.stdout.write(event.delta);
        break;
      case 'thinking_delta':
        // Smoke 默认只验证最终文本流，不展示模型的 reasoning。
        break;
      case 'toolcall_end':
        process.stderr.write(
          `\n[tool] ${event.call.name} ${JSON.stringify(event.call.arguments)}\n`,
        );
        break;
      case 'done':
        terminal = true;
        break;
      case 'error':
        terminal = true;
        process.stderr.write(`\n${event.message.errorMessage ?? 'Model call failed'}\n`);
        process.exitCode = 1;
        break;
    }
    if (isTerminalEvent(event)) break;
  }
  if (wroteText) process.stdout.write('\n');
  if (!terminal) {
    process.stderr.write('Model stream ended without a terminal event\n');
    process.exitCode = 1;
  }
}

async function runAgent(args: AgentArgs): Promise<void> {
  const { provider, model } = createAgentProvider(args);
  const session = await prepareSession(args, model);
  const tokenCounter = new O200kTokenCounter();
  const contextWindow = args.maxTokens ?? model.contextWindow;
  const spanExporter = args.trace ? new ConsoleSpanExporter() : undefined;
  const controller = new AbortController();
  const onInterrupt = (): void => {
    controller.abort(new Error('Interrupted by user'));
  };
  process.once('SIGINT', onInterrupt);
  let wroteText = false;
  try {
    const result = await runAgentLoop({
      provider,
      model,
      context: session.context,
      registry: createBuiltinToolRegistry(),
      toolContext: {
        signal: controller.signal,
        cwd: process.cwd(),
        trace: createTraceContext(),
        interaction: nonInteractiveInteraction(),
      },
      toolDeps: {
        admission: new StubAdmissionController(),
        permissions: new StubPermissionPolicy(),
        sandbox: new PassthroughSandbox(),
      },
      toolOptions: { maxResultChars: 8_000, toolTimeoutMs: 30_000 },
      loopConfig: { maxTurns: args.maxTurns, turnTimeoutMs: 120_000 },
      maxToolConcurrency: 4,
      compaction: {
        tokenCounter,
        policy: new ThresholdCompactPolicy({
          config: {
            compactThreshold: 0.8,
            memPressureThreshold: 0.75,
            keepRecentMessages: 6,
          },
          tokenCounter,
        }),
        summarizer: new StructuralSummarizer({ tokenCounter }),
        contextWindow,
        targetTokens: Math.max(1, Math.floor(contextWindow * 0.4)),
        ...(session.previousSummary === undefined
          ? {}
          : { previousSummary: session.previousSummary }),
      },
      ...(session.persistence === undefined
        ? {}
        : { persistence: session.persistence }),
      ...(spanExporter === undefined
        ? {}
        : { telemetry: { exporter: spanExporter } }),
      emit(event) {
        wroteText = renderAgentEvent(event) || wroteText;
      },
    });
    if (wroteText) process.stdout.write('\n');
    if (result.reason !== 'stop') process.exitCode = 1;
  } finally {
    await spanExporter?.flush();
    process.removeListener('SIGINT', onInterrupt);
  }
}

interface PreparedSession {
  context: Context;
  previousSummary?: Message;
  persistence?: AgentLoopPersistence;
}

async function prepareSession(
  args: AgentArgs,
  model: ModelRef,
): Promise<PreparedSession> {
  const userMessage: Message = {
    role: 'user',
    content: args.prompt,
    timestamp: Date.now(),
  };
  if (args.session === undefined) {
    return { context: { messages: [userMessage] } };
  }
  const sessionId = args.session;

  const store = new JsonlStore({
    rootDirectory: join(process.cwd(), '.ppagent', 'sessions'),
  });
  let records: StoreRecord[] = [];
  if (args.resume) {
    records = await store.load(sessionId);
  } else {
    await store.create({
      id: sessionId,
      cwd: process.cwd(),
      model: `${model.provider}/${model.id}`,
      title: args.prompt.slice(0, 80),
    });
  }

  let nextSequence =
    records.reduce((highest, record) => Math.max(highest, record.seq), 0) + 1;
  const previous = latestCompaction(records)?.summary;
  const messages = args.resume ? replay(records, 'compacted') : [];
  await store.append(sessionId, {
    kind: 'message',
    seq: nextSequence,
    message: userMessage,
  });
  nextSequence += 1;
  messages.push(userMessage);

  const persistence: AgentLoopPersistence = {
    async appendMessages(newMessages) {
      for (const message of newMessages) {
        await store.append(sessionId, {
          kind: 'message',
          seq: nextSequence,
          message,
        });
        nextSequence += 1;
      }
    },
    async appendCompaction(result: CompactResult) {
      await store.append(sessionId, {
        kind: 'compaction',
        seq: nextSequence,
        summary: result.summary,
        trigger: result.trigger,
        replacedCount: result.replacedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        meta: result.meta,
        timestamp: Date.now(),
      });
      nextSequence += 1;
    },
  };
  return {
    context: { messages },
    ...(previous === undefined ? {} : { previousSummary: previous }),
    persistence,
  };
}

function renderAgentEvent(event: UIEvent): boolean {
  switch (event.type) {
    case 'text_delta':
      process.stdout.write(event.delta);
      return event.delta.length > 0;
    case 'tool_start':
      process.stderr.write(
        `\n[tool:start] ${event.name} ${JSON.stringify(event.args)}\n`,
      );
      return false;
    case 'tool_end':
      process.stderr.write(
        `[tool:end] ${event.name} ${event.isError ? 'error' : 'ok'}: ${event.preview}\n`,
      );
      return false;
    case 'error':
      process.stderr.write(`\n${event.message}\n`);
      return false;
    case 'compacted':
      process.stderr.write(
        `\n[context:compacted] ${event.trigger} ${event.tokensBefore} → ${event.tokensAfter} tokens\n`,
      );
      return false;
    case 'turn_start':
    case 'thinking_delta':
    case 'permission_request':
    case 'permission_resolved':
    case 'admission_denied':
    case 'turn_end':
    case 'loop_end':
      return false;
  }
}

async function runTool(args: ToolArgs): Promise<void> {
  const controller = new AbortController();
  const context: ToolContext = {
    signal: controller.signal,
    cwd: process.cwd(),
    trace: createTraceContext(),
    interaction: nonInteractiveInteraction(),
  };
  const result = await executeToolCall(
    createBuiltinToolRegistry(),
    {
      type: 'toolCall',
      id: 'cli-tool-call',
      name: args.name,
      arguments: args.arguments,
    },
    context,
    {
      admission: new StubAdmissionController(),
      permissions: new StubPermissionPolicy(),
      sandbox: new PassthroughSandbox(),
    },
    { maxResultChars: 8_000, toolTimeoutMs: 30_000 },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.isError) process.exitCode = 1;
}

function parseSmokeArgs(args: string[]): SmokeArgs {
  let provider = 'faux';
  let model: string | undefined;
  const promptParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === '--smoke') continue;
    if (arg === '--provider' || arg === '--model') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--provider') provider = value;
      else model = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    promptParts.push(arg);
  }
  return {
    provider,
    ...(model === undefined ? {} : { model }),
    prompt:
      promptParts.join(' ').trim() || 'Reply with exactly: M2 smoke OK',
  };
}

function parseAgentArgs(args: string[]): AgentArgs {
  let provider = 'faux';
  let model: string | undefined;
  let maxTurns = 8;
  let maxTokens: number | undefined;
  let session: string | undefined;
  let resume = false;
  let trace = false;
  const promptParts: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--resume') {
      resume = true;
      continue;
    }
    if (arg === '--trace') {
      trace = true;
      continue;
    }
    if (
      arg === '--provider' ||
      arg === '--model' ||
      arg === '--max-turns' ||
      arg === '--max-tokens' ||
      arg === '--session'
    ) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--provider') provider = value;
      else if (arg === '--model') model = value;
      else if (arg === '--max-turns') {
        maxTurns = positiveInteger(value, '--max-turns');
      } else if (arg === '--max-tokens') {
        maxTokens = positiveInteger(value, '--max-tokens');
      } else {
        session = value;
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
    promptParts.push(arg);
  }
  const prompt = promptParts.join(' ').trim();
  if (prompt.length === 0) throw new Error('A prompt is required');
  if (resume && session === undefined) {
    throw new Error('--resume requires --session ID');
  }
  return {
    provider,
    ...(model === undefined ? {} : { model }),
    prompt,
    maxTurns,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(session === undefined ? {} : { session }),
    resume,
    trace,
  };
}

function parseToolArgs(args: string[]): ToolArgs {
  let name: string | undefined;
  let rawArguments = '{}';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--tool' || arg === '--args') {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      if (arg === '--tool') name = value;
      else rawArguments = value;
      index += 1;
      continue;
    }
    if (arg !== undefined) throw new Error(`Unknown tool option: ${arg}`);
  }
  if (name === undefined || name.trim().length === 0) {
    throw new Error('--tool requires a value');
  }
  return { name, arguments: parseOrKeepRaw(rawArguments) };
}

function createSmokeProvider(args: SmokeArgs): {
  provider: Provider;
  model: ModelRef;
} {
  if (args.provider === 'faux') {
    const provider = new FauxProvider({
      turns: [
        textTurn('M2 smoke OK', {
          chunkSize: 3,
          origin: { provider: 'faux', model: 'faux-model' },
        }),
      ],
    });
    return { provider, model: selectModel(provider, 'faux', args.model ?? 'faux-model') };
  }

  if (args.provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error('ANTHROPIC_API_KEY is required for the anthropic smoke test');
    }
    const provider = createPiAiProvider({
      providers: ['anthropic'],
      apiKeys: { anthropic: apiKey },
    });
    return {
      provider,
      model: selectModel(
        provider,
        'anthropic',
        args.model ?? 'claude-haiku-4-5',
      ),
    };
  }

  if (args.provider === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (apiKey === undefined || apiKey.trim().length === 0) {
      throw new Error('OPENAI_API_KEY is required for the openai smoke test');
    }
    const provider = createPiAiProvider({
      providers: ['openai'],
      apiKeys: { openai: apiKey },
    });
    return {
      provider,
      model: selectModel(
        provider,
        'openai',
        args.model ?? 'gpt-4.1-mini',
      ),
    };
  }

  if (args.provider === 'custom') {
    if (args.model === undefined) {
      throw new Error('--model is required for the custom smoke test');
    }
    const { baseUrl, apiKey } = readCustomSmokeEnvironment(process.env);
    const provider = createPiAiProvider({
      providers: [],
      customProviders: [
        {
          id: 'custom',
          baseUrl,
          models: [{ id: args.model }],
        },
      ],
      ...(apiKey === undefined ? {} : { apiKeys: { custom: apiKey } }),
    });
    return {
      provider,
      model: selectModel(provider, 'custom', args.model),
    };
  }

  throw new Error(`Unsupported smoke provider: ${args.provider}`);
}

function createAgentProvider(args: AgentArgs): {
  provider: Provider;
  model: ModelRef;
} {
  if (args.provider !== 'faux') return createSmokeProvider(args);
  const isCancellationAcceptance = /\bsleep\s+300\b/iu.test(args.prompt);
  const provider = new FauxProvider({
    turns: isCancellationAcceptance
      ? [
          toolCallTurn({
            id: `faux-bash-cancel-${crypto.randomUUID()}`,
            name: 'bash',
            // 同时包含前台与后台 sleep，端到端覆盖 shell 的孙进程清理。
            rawArguments: JSON.stringify({ cmd: 'sleep 300 & sleep 300' }),
            argumentChunkSize: 1,
          }),
          textTurn('The sleep command finished.'),
        ]
      : [
          toolCallTurn({
            // session 恢复后历史仍在上下文里；跨进程也必须保持 toolCallId 唯一。
            id: `faux-read-package-${crypto.randomUUID()}`,
            name: 'read',
            rawArguments: '{"path":"package.json"}',
            argumentChunkSize: 1,
          }),
          textTurn(
            'package.json declares runtime dependencies on @earendil-works/pi-ai and gpt-tokenizer.',
            { chunkSize: 8 },
          ),
        ],
  });
  return {
    provider,
    model: selectModel(provider, 'faux', args.model ?? 'faux-model'),
  };
}

function selectModel(provider: Provider, providerId: string, id: string): ModelRef {
  const model = findModel(provider.listModels(), providerId, id);
  if (model === undefined) throw new Error(`Unknown model: ${providerId}/${id}`);
  return model;
}

function parseOrKeepRaw(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

function nonInteractiveInteraction(): Interaction {
  return {
    confirm: async () => false,
    ask: async () => null,
    select: async () => null,
    notify: ({ level, message }) => {
      process.stderr.write(`[${level}] ${message}\n`);
    },
  };
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
