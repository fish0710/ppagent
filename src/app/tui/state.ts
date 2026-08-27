import type {
  PermissionDecision,
  ResourceSnapshot,
  UIEvent,
  Usage,
} from '../../core/types.js';
import type { BlockId, TranscriptBlock, TranscriptBlockBody } from './blocks.js';
import { describeTool, sanitizeStreamingText, sanitizeToolDisplay, segmentMarkdown, visibleCharacterCount } from './format.js';

export type TuiPhase =
  | 'idle'
  | 'prefill'
  /** 压缩上下文中。LLM 摘要在本地机器上可能跑几十秒，需要单独的相位。 */
  | 'compacting'
  | 'decode'
  | 'tool_running'
  | 'confirming'
  | 'error';

export interface TuiToolActivity {
  id: string;
  name: string;
  summary: string;
  startedAtMs: number;
}

export interface PendingPermission {
  toolName: string;
  summary: string;
  detail?: string;
  sandboxReason?: string;
  startedAtMs: number;
}

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 仅保存渲染所需的派生状态，不复制 Context、消息或 loop 状态。
 * blocks 一旦提交便不修改；pendingText/pendingThinking 是唯一允许原地重画的文本。
 */
export interface TuiState {
  phase: TuiPhase;
  blocks: readonly TranscriptBlock[];
  nextBlockId: BlockId;
  pendingText: string;
  pendingThinking: string;
  pendingPermission?: PendingPermission;
  turn: number;
  turnStartedAtMs?: number;
  decodeStartedAtMs?: number;
  decodedCharacters: number;
  contextTokens?: number;
  contextWindow?: number;
  compactStartedAtMs?: number;
  phaseBeforeCompaction?: TuiPhase;
  activeTools: Readonly<Record<string, TuiToolActivity>>;
  phaseBeforeConfirmation?: TuiPhase;
  lastUsage?: Usage;
  /** 累计到目前为止的 usage；供 /cost 这类只读展示用。 */
  totalUsage: Usage;
}

/** prompt_submitted 是 UI 输入，不是伪造的 Agent UIEvent。 */
export type TuiAction =
  | UIEvent
  | { type: 'prompt_submitted'; prompt: string };

export function createInitialTuiState(): TuiState {
  return {
    phase: 'idle',
    blocks: [],
    nextBlockId: 0,
    pendingText: '',
    pendingThinking: '',
    turn: 0,
    decodedCharacters: 0,
    activeTools: {},
    totalUsage: { ...ZERO_USAGE },
  };
}

/** 纯 reducer：相同 state/action/time 永远得到相同结果。 */
export function reduceTuiState(
  state: TuiState,
  action: TuiAction,
  nowMs: number,
): TuiState {
  switch (action.type) {
    case 'prompt_submitted':
      return appendBlock(commitPending(state), {
        kind: 'user',
        text: sanitizeStreamingText(action.prompt),
      });
    case 'turn_start':
      return {
        ...commitPending(state),
        phase: 'prefill',
        turn: action.turn,
        turnStartedAtMs: nowMs,
        decodedCharacters: 0,
        activeTools: {},
        ...(action.contextTokens === undefined
          ? {}
          : { contextTokens: action.contextTokens }),
        ...(action.contextWindow === undefined
          ? {}
          : { contextWindow: action.contextWindow }),
      };
    case 'text_delta': {
      const committedThinking = commitThinking(state);
      const combined = `${committedThinking.pendingText}${sanitizeStreamingText(action.delta)}`;
      const { segments, rest } = segmentMarkdown(combined);
      const withSegments = appendBlocks(
        committedThinking,
        segments.map((text): TranscriptBlockBody => ({ kind: 'assistant', text })),
      );
      return {
        ...withSegments,
        pendingText: rest,
        phase: 'decode',
        ...(state.decodeStartedAtMs === undefined ? { decodeStartedAtMs: nowMs } : {}),
        decodedCharacters:
          state.decodedCharacters + visibleCharacterCount(action.delta),
      };
    }
    case 'thinking_delta':
      return {
        ...state,
        pendingThinking: `${state.pendingThinking}${sanitizeStreamingText(action.delta)}`,
        phase: state.phase === 'tool_running' ? state.phase : 'decode',
        ...(state.decodeStartedAtMs === undefined ? { decodeStartedAtMs: nowMs } : {}),
        decodedCharacters:
          state.decodedCharacters + visibleCharacterCount(action.delta),
      };
    case 'tool_start':
      return {
        ...commitPending(state),
        phase: 'tool_running',
        activeTools: {
          ...state.activeTools,
          [action.id]: {
            id: action.id,
            name: action.name,
            summary: describeTool(action.name, action.args),
            startedAtMs: nowMs,
          },
        },
      };
    case 'tool_end': {
      const committed = commitPending(state);
      const activity = committed.activeTools[action.id];
      const activeTools = { ...committed.activeTools };
      delete activeTools[action.id];
      return appendBlock(
        {
          ...committed,
          phase: Object.keys(activeTools).length > 0 ? 'tool_running' : 'idle',
          activeTools,
        },
        {
          kind: 'tool',
          toolId: action.id,
          name: action.name,
          summary: activity?.summary ?? describeTool(action.name, undefined),
          isError: action.isError,
          durationMs: action.durationMs,
          preview: action.preview,
          ...(action.display === undefined
            ? {}
            : { display: sanitizeToolDisplay(action.display) }),
        },
      );
    }
    case 'permission_request': {
      const committed = commitPending(state);
      return {
        ...committed,
        phase: 'confirming',
        phaseBeforeConfirmation: committed.phase,
        pendingPermission: {
          toolName: action.req.toolName,
          summary: action.req.summary,
          startedAtMs: nowMs,
          ...(action.req.detail === undefined ? {} : { detail: action.req.detail }),
          ...(action.req.sandboxReason === undefined
            ? {}
            : { sandboxReason: action.req.sandboxReason }),
        },
      };
    }
    case 'permission_resolved':
      return resolvePermission(state, action.decision);
    case 'notify':
      return appendBlock(commitPending(state), {
        kind: 'notice',
        level: action.level,
        text: sanitizeStreamingText(action.message),
      });
    case 'admission_denied':
      return appendBlock(commitPending(state), {
        kind: 'admissionDenied',
        reason: sanitizeStreamingText(action.reason),
        retryAfterMs: action.retryAfterMs,
      });
    case 'compact_start':
      return {
        ...commitPending(state),
        phase: 'compacting',
        compactStartedAtMs: nowMs,
        phaseBeforeCompaction: state.phase,
      };
    case 'compact_skipped':
      return appendBlock(endCompaction(commitPending(state)), {
        kind: 'compaction',
        variant: 'skipped',
        trigger: action.trigger,
        reason: sanitizeStreamingText(action.reason),
      });
    case 'compacted':
      return appendBlock(
        { ...endCompaction(commitPending(state)), contextTokens: action.tokensAfter },
        {
          kind: 'compaction',
          variant: action.kind === 'prune' ? 'prune' : 'summarize',
          trigger: action.trigger,
          tokensBefore: action.tokensBefore,
          tokensAfter: action.tokensAfter,
          prunedCount: action.prunedCount,
          ...(action.strategy === undefined ? {} : { strategy: action.strategy }),
          ...(action.resourceSource === undefined
            ? {}
            : { resourceSource: action.resourceSource }),
        },
      );
    case 'turn_end':
      return finishTurn(state, action, nowMs);
    case 'loop_end':
      return finishLoop(state, action.reason);
    case 'error':
      return appendBlock(
        { ...commitPending(state), phase: 'error' },
        { kind: 'error', text: sanitizeStreamingText(action.message) },
      );
  }
}

/**
 * 回到压缩开始前的相位，而不是硬编码成 prefill —— 自动压缩发生在 turn_start
 * 之后（回到 prefill），手动 /compact 发生在 idle（该回到 idle）。
 */
function endCompaction(state: TuiState): TuiState {
  const {
    compactStartedAtMs: _startedAt,
    phaseBeforeCompaction,
    ...rest
  } = state;
  return { ...rest, phase: phaseBeforeCompaction ?? state.phase };
}

function resolvePermission(
  state: TuiState,
  decision: PermissionDecision,
): TuiState {
  const { phaseBeforeConfirmation, pendingPermission, ...rest } = state;
  const summary = pendingPermission?.summary ?? '';
  return appendBlock(
    { ...rest, phase: phaseBeforeConfirmation ?? inferredActivePhase(state) },
    {
      kind: 'permission',
      summary,
      decision,
      ...(pendingPermission?.detail === undefined
        ? {}
        : { detail: pendingPermission.detail }),
      ...(pendingPermission?.sandboxReason === undefined
        ? {}
        : { sandboxReason: pendingPermission.sandboxReason }),
    },
  );
}

function finishTurn(
  state: TuiState,
  event: Extract<UIEvent, { type: 'turn_end' }>,
  nowMs: number,
): TuiState {
  const committed = commitPending(state);
  const totalUsage: Usage = {
    input: committed.totalUsage.input + event.usage.input,
    output: committed.totalUsage.output + event.usage.output,
    cacheRead: committed.totalUsage.cacheRead + event.usage.cacheRead,
    cacheWrite: committed.totalUsage.cacheWrite + event.usage.cacheWrite,
  };
  const { decodeStartedAtMs, ...withoutDecodeStart } = committed;
  const next: TuiState = {
    ...withoutDecodeStart,
    phase: 'idle',
    lastUsage: event.usage,
    contextTokens: event.usage.input,
    decodedCharacters: 0,
    totalUsage,
  };
  // 工具调用紧接着这轮结束；指标行会插在 assistant 文本和工具块中间，读起来是错的，
  // 只在这一轮真正结束（不再继续调工具）时才提交。
  if (event.stopReason === 'toolUse') return next;
  return appendBlock(next, {
    kind: 'metrics',
    usage: event.usage,
    ...(decodeStartedAtMs === undefined ? {} : { decodeMs: nowMs - decodeStartedAtMs }),
    ...(committed.contextWindow === undefined ? {} : { contextWindow: committed.contextWindow }),
    contextTokens: event.usage.input,
  });
}

function finishLoop(
  state: TuiState,
  reason: Extract<UIEvent, { type: 'loop_end' }>['reason'],
): TuiState {
  const committed = commitPending(state);
  const { phaseBeforeConfirmation: _confirmation, ...withoutConfirmation } = committed;
  return appendBlock(
    { ...withoutConfirmation, phase: 'idle', activeTools: {} },
    { kind: 'loopEnd', reason },
  );
}

function commitThinking(state: TuiState): TuiState {
  if (state.pendingThinking.length === 0) return state;
  return appendBlock(
    { ...state, pendingThinking: '' },
    { kind: 'thinking', text: state.pendingThinking },
  );
}

/** 提交 pendingThinking 和 pendingText（若有）；每个非流式事件处理前都要调用一次，
 *  保证 blocks 数组里的顺序和事件到达顺序一致。空缓冲区时是纯粹的 no-op。 */
function commitPending(state: TuiState): TuiState {
  const withThinking = commitThinking(state);
  if (withThinking.pendingText.length === 0) return withThinking;
  // 强制 flush（没有更多流式内容跟上来了）；去掉尾随换行，和 segmentMarkdown
  // 正常切出的段落保持同样的形状，避免渲染出多余的空行。
  const text = withThinking.pendingText.replace(/\n+$/u, '');
  return appendBlock(
    { ...withThinking, pendingText: '' },
    { kind: 'assistant', text },
  );
}

function appendBlock(state: TuiState, body: TranscriptBlockBody): TuiState {
  return appendBlocks(state, [body]);
}

function appendBlocks(state: TuiState, bodies: readonly TranscriptBlockBody[]): TuiState {
  if (bodies.length === 0) return state;
  let nextId = state.nextBlockId;
  const newBlocks = bodies.map((body) => {
    const block: TranscriptBlock = { id: nextId, ...body };
    nextId += 1;
    return block;
  });
  return {
    ...state,
    blocks: [...state.blocks, ...newBlocks],
    nextBlockId: nextId,
  };
}

function inferredActivePhase(state: TuiState): TuiPhase {
  return Object.keys(state.activeTools).length > 0 ? 'tool_running' : 'prefill';
}
