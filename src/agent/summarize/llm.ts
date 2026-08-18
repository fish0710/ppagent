import { truncateToTokens } from '../../core/context/compact.js';
import { formatFileOperations } from '../../core/context/files.js';
import { looksLikeTextToolCall } from '../../core/loop/react.js';
import type {
  Message,
  ModelRef,
  Provider,
  SummarizeRequest,
  SummarizeResult,
  Summarizer,
  TokenCounter,
  Usage,
} from '../../core/types.js';
import {
  assembleSummary,
  getSection,
  mergeCarriedSection,
  parseSummarySections,
  type AssembleSummaryOptions,
} from './sections.js';

/**
 * 摘要指令。用英文写，因为多数本地模型的指令跟随在英文上更稳、也更省 token；
 * 段落键固定英文便于跨会话比对，正文语言由模型跟随对话本身决定。
 *
 * 模型只负责它必须判断的那几段。约束与关键决策的"已记录"部分、文件清单，
 * 都由 harness 搬运/计算，模型碰不到也不需要碰 —— 见 sections.ts 顶部注释。
 * 这是"凡是结构里已经有的就不问模型"这条原则在提示词层面的体现。
 *
 * 三件事是刻意反复强调的：
 *   1. 只输出文本。请求里带着完整 tools（前缀缓存要求如此），模型很可能顺手
 *      发起工具调用，首尾各说一遍能显著降低概率；真发了运行时也会丢弃。
 *   2. 上面是记录，不是要继续的对话。本地小模型最容易顺着最后一条消息接话
 *      或者顺手调个工具；这句话是免费补上的一层框架提醒。
 *   3. 标识符、路径、命令、报错原样引用。本地小模型最爱把 `foo_bar.ts` 转述成
 *      "那个配置文件"，一转述后续就再也找不回来了。
 */
export const COMPACT_INSTRUCTION = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tool — tool calls will be discarded.

Everything above is a RECORD of a conversation that is about to be compacted, not a conversation for you to continue or reply to. Treat it as material to analyze, the same way you would read a log file.

Everything before the retained tail will be permanently replaced by your reply, so your reply is the only memory that survives. Some sections are handled outside of your reply — you never need to restate them:
- Constraints & preferences and Key decisions already recorded earlier are carried forward automatically. Only report ones that are NEW in the record above.
- The list of files read and modified is computed separately. Do not list files yourself.

Write ONE self-contained response using exactly the headings below, in the same language the user has been using. Quote identifiers, paths, commands and error strings verbatim — never paraphrase them. Skip a heading only if it is genuinely empty; omit the heading line entirely rather than writing "none".

## Goal
## Next steps
(what the work looks like right now — this section fully replaces whatever it said before, it does not need to repeat old progress)

## Facts to carry forward
(exact paths, symbol names, commands that worked, error text)

## Done
(what got finished; if this list is long, merge older entries into coarser statements — this is the one section that is allowed to shrink over time)

## New constraints
(only requirements or preferences that appear for the first time in the record above)

## New decisions
(only decisions made for the first time in the record above; give each one its rationale)

No preamble, no addressing the user, no tool calls.`;

const SUMMARY_OPEN = '<compacted-session-summary>';
const SUMMARY_CLOSE = '</compacted-session-summary>';
const SUMMARY_LEAD_IN =
  '以下是此前对话被压缩后的摘要，它已取代压缩点之前的全部原始消息。基于它继续工作，不要重复已经完成的工作。';
const DONE_TRUNCATION_MARKER = '\n[... earlier progress omitted ...]';

export interface LlmSummarizerOptions {
  provider: Provider;
  model: ModelRef;
  tokenCounter: TokenCounter;
  /** 模型路径失败时的确定性兜底，通常是 StructuralSummarizer。 */
  fallback: Summarizer;
  /** 摘要生成的 token 上限。 */
  maxTokens: number;
  /** 摘要调用超时，独立于整轮超时。 */
  timeoutMs: number;
  /** 降级、超时等需要让用户知道的情况。 */
  notify?: (message: string) => void;
  now?: () => number;
}

/**
 * 调一次模型生成摘要，请求前缀与实活上下文逐字节相同。
 *
 * 为什么必须逐字节相同：llama.cpp / LM Studio / MLX server 的前缀缓存是在渲染并
 * tokenize 之后的 prompt 上做最长公共前缀匹配。chat template 把 tools 定义渲染
 * 进 system 段，所以少传一份 tools、改一条消息、换个顺序，prompt 都会从很靠前的
 * 位置起就不同，整段 KV 缓存作废 —— 摘要调用会退化成一次全量 prefill。
 * 云端 API 用显式 cache_control 断点，对此不敏感；本地服务敏感。
 *
 * 代价是 tools 还在请求里，模型可能吐工具调用。见 COMPACT_INSTRUCTION 的说明。
 *
 * 放在 agent/ 而不是 core/context/：depcruise 的 core-no-upward 与设计书都要求
 * context 不认识 llm，需要模型的摘要策略只能在装配层构造后注入。
 *
 * 模型只对它必须判断的那几段负责（Goal/Next steps/Facts/Done/New constraints/
 * New decisions）。已记录的约束与关键决策从旧摘要解析后原样搬运，文件清单由
 * core/context/files.ts 计算，两者都不经过模型转述 —— 见 sections.ts。
 */
export class LlmSummarizer implements Summarizer {
  readonly id = 'llm';
  readonly #options: LlmSummarizerOptions;
  readonly #now: () => number;

  constructor(options: LlmSummarizerOptions) {
    if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
      throw new Error('maxTokens must be a positive integer');
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new Error('timeoutMs must be a positive integer');
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  async summarize(request: SummarizeRequest): Promise<SummarizeResult> {
    const startedAt = this.#now();
    let usage: Usage | undefined;
    let text: string;
    try {
      const generated = await this.#generate(request);
      usage = generated.usage;
      text = generated.text;
    } catch (error) {
      // 用户主动取消不是失败，不降级 —— 降级会让 Ctrl+C 之后还继续跑一段活。
      if (request.signal.aborted) throw error;
      return this.#degrade(request, errorMessage(error));
    }

    const parsedModel = parseSummarySections(text);
    if (!parsedModel.matched) {
      // 一个 ## 标题都没有，说明模型没有按格式回答；宁可整体降级，也不要
      // 把它的自由文本硬塞进某个标题下，猜错了归类比丢弃更危险。
      return this.#degrade(request, '模型输出没有可识别的分段标题');
    }

    const carried = carriedSections(request.previousSummary);
    const fileOpsText =
      request.fileOps === undefined ? '' : formatFileOperations(request.fileOps);
    const base: Omit<AssembleSummaryOptions, 'done'> = {
      goal: getSection(parsedModel, 'Goal'),
      constraints: mergeCarriedSection(
        carried.constraints,
        getSection(parsedModel, 'New constraints'),
      ),
      nextSteps: getSection(parsedModel, 'Next steps'),
      keyDecisions: mergeCarriedSection(
        carried.keyDecisions,
        getSection(parsedModel, 'New decisions'),
      ),
      facts: getSection(parsedModel, 'Facts to carry forward'),
      fileOpsText,
      ...(carried.earlierContext === undefined
        ? {}
        : { earlierContext: carried.earlierContext }),
    };
    const done = getSection(parsedModel, 'Done');

    const wrap = (body: string): string =>
      `${SUMMARY_LEAD_IN}\n\n${SUMMARY_OPEN}\n${body}\n${SUMMARY_CLOSE}`;
    const bodyBudget =
      request.targetTokens === undefined
        ? undefined
        : Math.max(
            1,
            request.targetTokens - this.#options.tokenCounter.countText(wrap('')),
          );
    const assembled = this.#assembleWithinBudget(base, done, bodyBudget);
    if (assembled.trim().length === 0) {
      return this.#degrade(request, '摘要正文为空');
    }

    const endedAt = this.#now();
    return {
      // UserMessage：压缩后它是上下文首条，Anthropic API 要求首条为 user，部分
      // 本地服务同样挑剔；语义上也更准 —— 摘要是 harness 塞的背景材料。
      // synthetic: true 防止它被"user 消息不折叠"策略误当成真实用户输入。
      summary: { role: 'user', content: wrap(assembled), timestamp: endedAt, synthetic: true },
      meta: {
        strategy: this.id,
        tokensIn: usage?.input ?? 0,
        tokensOut: usage?.output ?? 0,
        latencyMs: Math.max(0, endedAt - startedAt),
        modelCalls: 1,
      },
    };
  }

  /**
   * 超预算时只截 `## Done` 一段，不做全文截尾 —— Done 是唯一授权被压缩的段，
   * Constraints/Key decisions/Facts 不该因为篇幅不够而被牺牲。
   *
   * 极端情况（约束或文件清单本身就巨大）下 overhead 可能已经超预算，此时退到
   * 整篇尾部截断兜底；因为 Done 排在拼装顺序的最后，尾部截断天然先牺牲它——
   * 模板顺序是这条兜底能安全生效的前提，见 sections.ts 的 assembleSummary。
   */
  #assembleWithinBudget(
    base: Omit<AssembleSummaryOptions, 'done'>,
    done: string,
    bodyBudget: number | undefined,
  ): string {
    const counter = this.#options.tokenCounter;
    const full = assembleSummary({ ...base, done });
    if (bodyBudget === undefined || counter.countText(full) <= bodyBudget) {
      return full;
    }
    const withoutDone = assembleSummary({ ...base, done: '' });
    const overhead = counter.countText(withoutDone);
    // "## Done\n" 本身的开销：done 目前算出来是空，但截断后会重新填上内容，
    // 那时这行标题会一起出现，必须提前把它的开销扣掉。
    const doneHeadingOverhead = counter.countText('\n\n## Done\n');
    const doneBudget = Math.max(0, bodyBudget - overhead - doneHeadingOverhead);
    const truncatedDone = truncateToTokens(done, doneBudget, counter, DONE_TRUNCATION_MARKER);
    const rebuilt = assembleSummary({ ...base, done: truncatedDone });
    if (counter.countText(rebuilt) <= bodyBudget) return rebuilt;
    return truncateToTokens(rebuilt, bodyBudget, counter);
  }

  /**
   * 重建实活上下文并追加指令。
   * `[previousSummary?, ...carried, ...messages, ...retained]` 由
   * ThresholdCompactPolicy 保证逐字节等于当前的 context.messages。
   */
  async #generate(
    request: SummarizeRequest,
  ): Promise<{ text: string; usage?: Usage }> {
    const instruction =
      request.instructions === undefined || request.instructions.trim().length === 0
        ? COMPACT_INSTRUCTION
        : `${COMPACT_INSTRUCTION}\n\nAdditional instructions from the user for this summary:\n${request.instructions.trim()}`;
    const messages: Message[] = [
      ...(request.previousSummary === undefined ? [] : [request.previousSummary]),
      ...(request.carried ?? []),
      ...request.messages,
      ...(request.retained ?? []),
      { role: 'user', content: instruction, timestamp: this.#now() },
    ];
    const control = createTimeout(request.signal, this.#options.timeoutMs);
    let text = '';
    let usage: Usage | undefined;
    let sawToolCall = false;
    try {
      const stream = this.#options.provider.stream(
        this.#options.model,
        {
          ...(request.systemPrompt === undefined
            ? {}
            : { systemPrompt: request.systemPrompt }),
          messages,
          ...(request.tools === undefined ? {} : { tools: request.tools }),
        },
        {
          signal: control.signal,
          maxTokens: this.#options.maxTokens,
          // 摘要要可复现，也不需要发散。
          temperature: 0,
          timeoutMs: this.#options.timeoutMs,
        },
      );
      for await (const event of stream) {
        switch (event.type) {
          case 'text_delta':
            text += event.delta;
            break;
          case 'toolcall_end':
            // 请求里带着 tools 是前缀缓存的代价；本地小模型守不住 TEXT ONLY 是常态。
            sawToolCall = true;
            break;
          case 'done':
            usage = event.message.usage;
            break;
          case 'error':
            // provider 以事件收尾而非抛异常，这里必须显式消费。
            throw new Error(
              event.message.errorMessage ?? 'Summarization request failed.',
            );
          default:
            break;
        }
      }
    } finally {
      control.dispose();
    }
    if (control.timedOut() && text.trim().length === 0) {
      throw new Error(`Summarization timed out after ${this.#options.timeoutMs} ms`);
    }
    if (sawToolCall && text.trim().length === 0) {
      throw new Error('模型只发起了工具调用，没有产出摘要');
    }
    // sawToolCall 只覆盖原生 toolcall_end 事件；模型也可能把工具调用当纯文本
    // 写进 text_delta（<tool_call> 标签或裸 JSON），这种情况文本非空、上面两个
    // 检查都不会触发，若不单独拦截就会被当成合法摘要正文收下。
    const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
    if (looksLikeTextToolCall(text, toolNames)) {
      throw new Error('模型把工具调用伪装成了纯文本');
    }
    return { text, ...(usage === undefined ? {} : { usage }) };
  }

  /**
   * 降级到规则摘要。压缩失败绝不能连带杀掉一轮 turn —— 本地服务掉线、模型不
   * 守指令、生成超时都是常态，代价应该是摘要质量下降，而不是任务中断。
   */
  async #degrade(
    request: SummarizeRequest,
    reason: string,
  ): Promise<SummarizeResult> {
    this.#options.notify?.(`LLM 摘要失败（${reason}），已降级为规则摘要`);
    const startedAt = this.#now();
    const fallback = await this.#options.fallback.summarize(request);
    return {
      summary: fallback.summary,
      meta: {
        ...fallback.meta,
        strategy: `${this.id}-fallback-${fallback.meta.strategy}`,
        // 模型确实被调用过（并且失败了），成本要记在账上。
        modelCalls: 1,
        latencyMs: Math.max(0, this.#now() - startedAt) + fallback.meta.latencyMs,
      },
    };
  }
}

/**
 * 从旧摘要里搬运已记录的约束与关键决策。
 *
 * 旧摘要不一定是 LlmSummarizer 自己产出的 —— 上一次压缩若失败过，
 * previousSummary 可能来自 StructuralSummarizer 的兜底格式（没有 ## 标题，
 * 也没有 <compacted-session-summary> 包装）。两种情况都要安全处理：
 * 能解析就精确搬运两段；解析不出来就把整段原文当"未解析的早期上下文"
 * 整体保留，而不是丢弃或者猜它属于哪一段。
 */
function carriedSections(previousSummary: Message | undefined): {
  constraints: string;
  keyDecisions: string;
  earlierContext?: string;
} {
  if (previousSummary === undefined) return { constraints: '', keyDecisions: '' };
  const body = unwrapSummaryBody(previousSummary);
  const parsed = parseSummarySections(body);
  if (!parsed.matched) return { constraints: '', keyDecisions: '', earlierContext: body };
  return {
    constraints: getSection(parsed, 'Constraints & preferences'),
    keyDecisions: getSection(parsed, 'Key decisions'),
  };
}

function unwrapSummaryBody(message: Message): string {
  const content = typeof message.content === 'string' ? message.content : '';
  const openIndex = content.indexOf(SUMMARY_OPEN);
  // 找不到包装标签：不是 LlmSummarizer 的产物（例如 StructuralSummarizer 的
  // 兜底输出），整段当原文处理。
  if (openIndex === -1) return content;
  const start = openIndex + SUMMARY_OPEN.length;
  const closeIndex = content.indexOf(SUMMARY_CLOSE, start);
  return closeIndex === -1 ? content.slice(start) : content.slice(start, closeIndex);
}

/**
 * 把外层取消与摘要自己的 deadline 合并。timedOut 单独保留，避免只看
 * signal.aborted 时分不清用户取消和摘要超时 —— 前者不该降级，后者该。
 */
function createTimeout(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; timedOut(): boolean; dispose(): void } {
  const controller = new AbortController();
  let timeoutReached = false;
  const onAbort = (): void => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort(new Error('Summarization timed out'));
  }, timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
