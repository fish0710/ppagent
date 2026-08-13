import { countTokens } from 'gpt-tokenizer';
import type {
  ContentBlock,
  ReadonlyContext,
  Message,
  TokenCounter,
} from '../types.js';

/**
 * M5 的默认真实 BPE 计数器。
 *
 * o200k_base 不是所有本地模型的词表，所以计数器保持可注入；M11 接具体
 * endpoint/model 时可换成服务端 tokenizer。这里的重要边界是“不用字符数估算”。
 */
export class O200kTokenCounter implements TokenCounter {
  readonly id = 'o200k_base';

  countText(text: string): number {
    return countTokens(text);
  }

  countMessages(messages: readonly Message[]): number {
    return this.countText(JSON.stringify(messages.map(messageTokenShape)));
  }

  countContext(context: ReadonlyContext): number {
    return this.countText(
      JSON.stringify({
        ...(context.systemPrompt === undefined
          ? {}
          : { systemPrompt: context.systemPrompt }),
        messages: context.messages.map(messageTokenShape),
        ...(context.tools === undefined ? {} : { tools: context.tools }),
      }),
    );
  }
}

function messageTokenShape(message: Message): unknown {
  switch (message.role) {
    case 'user':
      return {
        role: message.role,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map(contentTokenShape),
      };
    case 'assistant':
      return {
        role: message.role,
        content: message.content.map(contentTokenShape),
      };
    case 'toolResult':
      return {
        role: message.role,
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: message.content.map(contentTokenShape),
        isError: message.isError,
        ...(message.truncated === true ? { truncated: true } : {}),
      };
  }
}

function contentTokenShape(block: ContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: block.type, text: block.text };
    case 'thinking':
      return { type: block.type, thinking: block.thinking };
    case 'toolCall':
      return {
        type: block.type,
        id: block.id,
        name: block.name,
        arguments: safeStringify(block.arguments),
      };
    case 'image':
      // 图片 token 取决于 provider 的视觉编码，不把 base64 字符误算成文本 token。
      return { type: block.type, mimeType: block.mimeType, image: '[binary]' };
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}
