import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FauxProvider,
  createPiAiProvider,
  findModel,
  isTerminalEvent,
  textTurn,
  type Context,
  type ModelRef,
  type Provider,
} from '../dist/core/llm/index.js';
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

function printVersion(): void {
  process.stdout.write(`${pkg.name} ${pkg.version}\n`);
}

function printHelp(): void {
  process.stdout.write(`Usage:
  agent --version
  agent --smoke [--provider faux|anthropic|openai|custom] [--model MODEL] [PROMPT]

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
  if (!args.includes('--smoke')) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const smokeArgs = parseSmokeArgs(args);
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

function selectModel(provider: Provider, providerId: string, id: string): ModelRef {
  const model = findModel(provider.listModels(), providerId, id);
  if (model === undefined) throw new Error(`Unknown model: ${providerId}/${id}`);
  return model;
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
