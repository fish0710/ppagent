import type {
  Context,
  LoopConfig,
  LoopEndReason,
  ModelRef,
  Provider,
  ToolContext,
  UIEvent,
} from '../types.js';
import type {
  ToolExecutorDeps,
  ToolExecutorOptions,
} from '../tools/execute.js';
import { ToolRegistry } from '../tools/registry.js';
import { executeReactTools, runReactTurn } from './react.js';

export interface AgentLoopOptions {
  provider: Provider;
  model: ModelRef;
  /** 调用方提供的初始上下文；loop 会复制 messages，不改原数组。 */
  context: Context;
  /** 既用于生成发给模型的 ToolDef，也用于执行模型返回的调用。 */
  registry: ToolRegistry;
  /** 其中的 signal 是整次 loop 的根取消信号。 */
  toolContext: ToolContext;
  toolDeps: ToolExecutorDeps;
  toolOptions: ToolExecutorOptions;
  loopConfig: LoopConfig;
  maxToolConcurrency?: number;
  /** UIEvent 是严格有序的同步出口；不提供时仍可把 loop 当普通函数使用。 */
  emit?: (event: UIEvent) => void;
}

export interface AgentLoopResult {
  /** 包含本次新增 assistant/toolResult 消息的最终内存视图。 */
  context: Context;
  reason: LoopEndReason;
  turns: number;
}

/**
 * 运行 ReAct 循环，直到模型正常结束、轮次耗尽、用户取消或出现错误。
 *
 * M4 只维护内存消息数组；M5 再把 context/store/compact 接进来。
 */
export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  validateOptions(options);
  const emit = options.emit ?? (() => undefined);
  const signal = options.toolContext.signal;
  const definitions = options.registry.definitions();
  // registry 才是本轮可执行工具的事实来源，丢弃调用方可能遗留的旧 tools。
  const { tools: _previousTools, ...contextWithoutTools } = options.context;
  const context: Context = {
    ...contextWithoutTools,
    // M4 不做持久化，但也不应把新增消息写回调用方持有的原数组。
    messages: [...options.context.messages],
    ...(definitions.length === 0 ? {} : { tools: definitions }),
  };
  // 所有正常出口都走 finish，保证每次运行恰好产生一个 loop_end。
  const finish = (reason: LoopEndReason, turns: number): AgentLoopResult => {
    emit({ type: 'loop_end', reason, turns });
    return { context, reason, turns };
  };

  if (signal.aborted) return finish('aborted', 0);

  for (let turn = 1; turn <= options.loopConfig.maxTurns; turn += 1) {
    if (signal.aborted) return finish('aborted', turn - 1);
    emit({ type: 'turn_start', turn });
    // 单轮控制器同时包住模型生成和随后的工具执行；超时不是只限制 HTTP。
    const control = createTurnControl(
      signal,
      options.loopConfig.turnTimeoutMs,
      turn,
    );
    try {
      const generated = await runReactTurn({
        provider: options.provider,
        model: options.model,
        context,
        signal: control.signal,
        emit,
      });
      // 先落 assistant 消息再发 turn_end，订阅者看到事件时内存状态已经一致。
      context.messages.push(generated.message);
      emit({
        type: 'turn_end',
        turn,
        usage: generated.message.usage,
        stopReason: generated.message.stopReason,
      });

      // 根取消优先于单轮超时：用户主动取消不应被展示成 timeout。
      if (signal.aborted) return finish('aborted', turn);
      if (control.timedOut()) {
        emit({
          type: 'error',
          message: `Agent turn ${turn} timed out after ${options.loopConfig.turnTimeoutMs} ms.`,
        });
        return finish('error', turn);
      }
      // Provider 以 error 事件收尾，不靠异常；这里必须显式消费 terminal。
      if (generated.terminal === 'error') {
        if (generated.message.stopReason === 'aborted') {
          return finish('aborted', turn);
        }
        emit({
          type: 'error',
          message: generated.message.errorMessage ?? 'Model call failed.',
        });
        return finish('error', turn);
      }
      // 文本化工具调用是配置错误，不能把它当普通 stop 静默结束。
      if (generated.diagnostic !== undefined) {
        emit({ type: 'error', message: generated.diagnostic });
        return finish('error', turn);
      }

      if (generated.toolCalls.length > 0) {
        // 所有调用都要得到一条 ToolResultMessage，保持 toolCall/toolResult 配对。
        const results = await executeReactTools(
          generated.toolCalls,
          {
            registry: options.registry,
            context: { ...options.toolContext, signal: control.signal },
            deps: options.toolDeps,
            options: options.toolOptions,
            maxConcurrency: options.maxToolConcurrency ?? 4,
            emit,
          },
        );
        // executeReactTools 即使遇到校验失败也返回工具结果，不会打断整轮。
        context.messages.push(...results);
        if (signal.aborted) return finish('aborted', turn);
        if (control.timedOut()) {
          emit({
            type: 'error',
            message: `Agent turn ${turn} timed out after ${options.loopConfig.turnTimeoutMs} ms.`,
          });
          return finish('error', turn);
        }
        // 已执行完最后允许的一轮动作，但没有额度让模型读取结果并继续。
        if (turn === options.loopConfig.maxTurns) {
          return finish('maxTurns', turn);
        }
        continue;
      }

      // 没有工具调用时，stopReason 必须决定一个显式出口，不能隐式 break。
      switch (generated.message.stopReason) {
        case 'stop':
          return finish('stop', turn);
        case 'aborted':
          return finish('aborted', turn);
        case 'length':
          emit({
            type: 'error',
            message: 'Model response reached its output token limit.',
          });
          return finish('error', turn);
        case 'toolUse':
          emit({
            type: 'error',
            message: 'Model reported toolUse without a complete native tool call.',
          });
          return finish('error', turn);
        case 'error':
          emit({
            type: 'error',
            message: generated.message.errorMessage ?? 'Model call failed.',
          });
          return finish('error', turn);
      }
    } finally {
      // 清理根 signal 监听器与 timer；任何 return 都不能绕过。
      control.dispose();
    }
  }

  // for 的上限已经在工具继续分支显式返回；保留为不可达防线。
  return finish('maxTurns', options.loopConfig.maxTurns);
}

export { runReactTurn } from './react.js';

/**
 * 把整次 loop 的根取消与单轮 deadline 合并成一个下游 signal。
 * timedOut 单独保留来源，避免仅看 signal.aborted 时分不清用户取消和超时。
 */
function createTurnControl(
  parent: AbortSignal,
  timeoutMs: number,
  turn: number,
): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timeoutReached = false;
  const onAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new Error(`Agent turn ${turn} timed out`));
  }, timeoutMs);
  // deadline 不应单独阻止一个已无其他工作的 Node 进程退出。
  timer.unref();
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function validateOptions(options: AgentLoopOptions): void {
  if (
    !Number.isInteger(options.loopConfig.maxTurns) ||
    options.loopConfig.maxTurns < 1
  ) {
    throw new Error('maxTurns must be a positive integer');
  }
  if (
    !Number.isInteger(options.loopConfig.turnTimeoutMs) ||
    options.loopConfig.turnTimeoutMs < 1
  ) {
    throw new Error('turnTimeoutMs must be a positive integer');
  }
  const concurrency = options.maxToolConcurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('maxToolConcurrency must be a positive integer');
  }
}
