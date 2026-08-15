import type { AgentProviderConfig } from '../config/index.js';
import {
  FauxProvider,
  createPiAiProvider,
  findModel,
  type FauxTurn,
  type ModelRef,
  type PiAiBuiltinProvider,
  type Provider,
} from '../../core/llm/index.js';

export interface ProviderSelection {
  provider: Provider;
  model: ModelRef;
}

export interface CreateConfiguredProviderOptions {
  fauxTurns?: FauxTurn[];
}

/** 只消费已合并的普通配置，不读取 env 或配置文件。 */
export function createConfiguredProvider(
  config: AgentProviderConfig,
  options: CreateConfiguredProviderOptions = {},
): ProviderSelection {
  if (config.id === 'faux') {
    const provider = new FauxProvider({ turns: options.fauxTurns ?? [] });
    return {
      provider,
      model: requiredModel(provider, 'faux', config.model ?? 'faux-model'),
    };
  }

  if (isLocalProvider(config.id)) {
    if (config.model === undefined) {
      throw new Error('provider.model is required for the custom provider');
    }
    const baseUrl = config.baseUrl ?? defaultLocalBaseUrl(config.id);
    if (baseUrl === undefined) {
      throw new Error('provider.baseUrl is required for the custom provider');
    }
    const provider = createPiAiProvider({
      providers: [],
      customProviders: [
        {
          id: config.id,
          baseUrl,
          models: [{ id: config.model }],
        },
      ],
      ...(config.apiKey === undefined
        ? {}
        : { apiKeys: { [config.id]: config.apiKey } }),
    });
    return {
      provider,
      model: requiredModel(provider, config.id, config.model),
    };
  }

  if (isBuiltinProvider(config.id)) {
    if (config.apiKey === undefined) {
      throw new Error(`An API key is required for provider ${config.id}`);
    }
    const provider = createPiAiProvider({
      providers: [config.id],
      apiKeys: { [config.id]: config.apiKey },
    });
    const modelId =
      config.model ??
      (config.id === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4.1-mini');
    return {
      provider,
      model: requiredModel(provider, config.id, modelId),
    };
  }

  throw new Error(`Unsupported provider: ${config.id}`);
}

function isLocalProvider(value: string): boolean {
  return value === 'custom' || value === 'lmstudio' || value === 'llamacpp';
}

function defaultLocalBaseUrl(provider: string): string | undefined {
  if (provider === 'lmstudio') return 'http://localhost:1234/v1';
  if (provider === 'llamacpp') return 'http://localhost:8080/v1';
  return undefined;
}

function isBuiltinProvider(value: string): value is PiAiBuiltinProvider {
  return value === 'anthropic' || value === 'openai';
}

function requiredModel(
  provider: Provider,
  providerId: string,
  modelId: string,
): ModelRef {
  const model = findModel(provider.listModels(), providerId, modelId);
  if (model === undefined) {
    throw new Error(`Unknown model: ${providerId}/${modelId}`);
  }
  return model;
}
