import type {
  PermissionDecision,
  ResourceSnapshot,
  UIEvent,
  Usage,
} from '../../core/types.js';

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

/**
 * 仅保存渲染所需的派生状态，不复制 Context、消息或 loop 状态。
 * transcript 一旦追加便不修改；pendingText 是唯一允许原地重画的文本。
 */
export interface TuiState {
  phase: TuiPhase;
  transcript: readonly string[];
  pendingText: string;
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
}

/** prompt_submitted 是 UI 输入，不是伪造的 Agent UIEvent。 */
export type TuiAction =
  | UIEvent
  | { type: 'prompt_submitted'; prompt: string };

export function createInitialTuiState(): TuiState {
  return {
    phase: 'idle',
    transcript: [],
    pendingText: '',
    turn: 0,
    decodedCharacters: 0,
    activeTools: {},
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
      return appendTranscript(state, promptLines(action.prompt));
    case 'turn_start':
      return {
        ...state,
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
      const streamed = appendStreamText(state, action.delta);
      return {
        ...streamed,
        phase: 'decode',
        ...(state.decodeStartedAtMs === undefined
          ? { decodeStartedAtMs: nowMs }
          : {}),
        decodedCharacters:
          state.decodedCharacters + visibleCharacterCount(action.delta),
      };
    }
    case 'thinking_delta':
      // 思考内容不进入 transcript；prefill 仍以首个用户可见文本为边界。
      return state;
    case 'tool_start':
      return {
        ...state,
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
      const activity = state.activeTools[action.id];
      const activeTools = { ...state.activeTools };
      delete activeTools[action.id];
      const summary = activity?.summary ?? action.name;
      const preview = oneLine(action.preview);
      const line = `${action.isError ? '⊘' : '⏺'} ${summary} ${formatDuration(
        action.durationMs,
      )}${action.isError && preview.length > 0 ? ` — ${preview}` : ''}`;
      return appendTranscript(
        {
          ...state,
          phase: Object.keys(activeTools).length > 0 ? 'tool_running' : 'idle',
          activeTools,
        },
        [line],
      );
    }
    case 'permission_request': {
      const committed = commitPending(state);
      const lines = [`? ${oneLine(action.req.summary)}`];
      if (action.req.sandboxReason !== undefined) {
        lines.push(`  沙箱：${oneLine(action.req.sandboxReason)}`);
      }
      return appendTranscript(
        {
          ...committed,
          phase: 'confirming',
          phaseBeforeConfirmation: committed.phase,
        },
        lines,
      );
    }
    case 'permission_resolved':
      return resolvePermission(state, action.decision);
    case 'notify':
      return appendTranscript(state, [
        `${notificationIcon(action.level)} ${oneLine(action.message)}`,
      ]);
    case 'admission_denied':
      return appendTranscript(state, [formatAdmissionDenied(action)]);
    case 'compact_start':
      return {
        ...state,
        phase: 'compacting',
        compactStartedAtMs: nowMs,
        phaseBeforeCompaction: state.phase,
      };
    case 'compact_skipped':
      return appendTranscript(endCompaction(state), [
        `⟳ 未压缩：${oneLine(action.reason)}`,
      ]);
    case 'compacted':
      return appendTranscript(
        { ...endCompaction(state), contextTokens: action.tokensAfter },
        [formatCompaction(action)],
      );
    case 'turn_end':
      return finishTurn(state, action, nowMs);
    case 'loop_end':
      return finishLoop(state, action.reason);
    case 'error':
      return appendTranscript(
        { ...commitPending(state), phase: 'error' },
        [`⊘ ${oneLine(action.message)}`],
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
  const {
    phaseBeforeConfirmation,
    ...withoutConfirmationPhase
  } = state;
  return appendTranscript(
    {
      ...withoutConfirmationPhase,
      phase: phaseBeforeConfirmation ?? inferredActivePhase(state),
    },
    [`  → ${permissionLabel(decision)}`],
  );
}

function finishTurn(
  state: TuiState,
  event: Extract<UIEvent, { type: 'turn_end' }>,
  nowMs: number,
): TuiState {
  const committed = commitPending(state);
  const lines: string[] = [];
  if (committed.decodeStartedAtMs !== undefined && event.usage.output > 0) {
    const seconds = Math.max((nowMs - committed.decodeStartedAtMs) / 1_000, 0.001);
    const rate = event.usage.output / seconds;
    const context = formatContext(event.usage.input, committed.contextWindow);
    lines.push(`  ↳ ${formatRate(rate)} tok/s${context === '' ? '' : ` · ${context}`}`);
  }
  const { decodeStartedAtMs: _decodeStartedAtMs, ...withoutDecodeStart } = committed;
  return appendTranscript(
    {
      ...withoutDecodeStart,
      phase: 'idle',
      lastUsage: event.usage,
      contextTokens: event.usage.input,
      decodedCharacters: 0,
    },
    lines,
  );
}

function finishLoop(
  state: TuiState,
  reason: Extract<UIEvent, { type: 'loop_end' }>['reason'],
): TuiState {
  const committed = commitPending(state);
  const { phaseBeforeConfirmation: _confirmation, ...withoutConfirmation } = committed;
  const lines =
    reason === 'aborted'
      ? ['⏹ 已取消']
      : reason === 'maxTurns'
        ? ['⊘ 已达到最大轮数']
        : reason === 'error'
          ? ['⊘ Agent 因错误停止']
          : [];
  return appendTranscript(
    { ...withoutConfirmation, phase: 'idle', activeTools: {} },
    lines,
  );
}

function appendStreamText(state: TuiState, delta: string): TuiState {
  const combined = `${state.pendingText}${sanitizeStreamingText(delta)}`;
  const parts = combined.split('\n');
  const pendingText = parts.pop() ?? '';
  return appendTranscript({ ...state, pendingText }, parts);
}

function commitPending(state: TuiState): TuiState {
  if (state.pendingText.length === 0) return state;
  return appendTranscript({ ...state, pendingText: '' }, [state.pendingText]);
}

function appendTranscript(state: TuiState, lines: readonly string[]): TuiState {
  if (lines.length === 0) return state;
  return {
    ...state,
    transcript: [...state.transcript, ...lines],
  };
}

function promptLines(prompt: string): string[] {
  const lines = sanitizeStreamingText(prompt).split('\n');
  return lines.map((line, index) => `${index === 0 ? '> ' : '  '}${line}`);
}

function inferredActivePhase(state: TuiState): TuiPhase {
  return Object.keys(state.activeTools).length > 0 ? 'tool_running' : 'prefill';
}

function permissionLabel(decision: PermissionDecision): string {
  switch (decision) {
    case 'allow':
      return '已允许';
    case 'allowAlways':
      return '已始终允许';
    case 'deny':
      return '已拒绝';
  }
}

function notificationIcon(level: 'info' | 'warn' | 'error'): string {
  return level === 'info' ? 'ℹ' : level === 'warn' ? '⚠' : '⊘';
}

function formatAdmissionDenied(event: Extract<UIEvent, { type: 'admission_denied' }>): string {
  const retry =
    event.retryAfterMs === null
      ? ''
      : `，建议 ${formatDuration(event.retryAfterMs)} 后重试`;
  return `⊘ 子 agent 被拒：${oneLine(event.reason)}${retry}`;
}

function formatCompaction(event: Extract<UIEvent, { type: 'compacted' }>): string {
  const trigger =
    event.trigger === 'memory'
      ? '内存压力'
      : event.trigger === 'token'
        ? '上下文阈值'
        : '手动触发';
  // 剪枝和摘要的信息损失不是一个量级，标签必须能区分：剪枝只降了老工具输出
  // 的保真度，摘要则把那段历史整个换成了模型的转述。
  const label = event.kind === 'prune' ? '剪枝' : '压缩';
  const detail = [
    trigger,
    ...(event.strategy === undefined ? [] : [event.strategy]),
    ...(event.kind === 'prune' ? [`${event.prunedCount} 条工具输出`] : []),
    ...(event.resourceSource === undefined
      ? []
      : [resourceLabel(event.resourceSource)]),
  ].join(' · ');
  return `⟳ ${label} ${formatTokenCount(event.tokensBefore)}→${formatTokenCount(
    event.tokensAfter,
  )}（${detail}）`;
}

function resourceLabel(source: ResourceSnapshot['source']): string {
  switch (source) {
    case 'memory_pressure':
      return 'memory_pressure';
    case 'vm_stat':
      return 'vm_stat';
    case 'system':
      return 'system';
    case 'test':
      return 'test probe';
  }
}

export function describeTool(name: string, args: unknown): string {
  if (isRecord(args)) {
    if (name === 'bash' && typeof args['cmd'] === 'string') {
      return `bash ${oneLine(args['cmd'])}`;
    }
    if (
      (name === 'read' || name === 'write' || name === 'edit') &&
      typeof args['path'] === 'string'
    ) {
      return `${name} ${oneLine(args['path'])}`;
    }
    if (name === 'spawn_subagent' && typeof args['task'] === 'string') {
      return `子 agent ${oneLine(args['task'])}`;
    }
  }
  return `${name} ${safeOneLineJson(args)}`.trimEnd();
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimFixed(value / 1_000)}k`;
  return String(Math.max(0, Math.round(value)));
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
  return `${trimFixed(durationMs / 1_000)}s`;
}

export function formatRate(rate: number): string {
  if (rate >= 1_000) return formatTokenCount(rate);
  return rate >= 100 ? String(Math.round(rate)) : trimFixed(rate);
}

export function formatContext(
  contextTokens: number | undefined,
  contextWindow: number | undefined,
): string {
  if (contextTokens === undefined) return '';
  return `上下文 ${formatTokenCount(contextTokens)}${
    contextWindow === undefined ? '' : `/${formatTokenCount(contextWindow)}`
  }`;
}

/** 删除能控制终端的字符；换行作为 transcript 的提交边界保留。 */
export function sanitizeStreamingText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu, '');
}

function oneLine(value: string): string {
  return sanitizeStreamingText(value).replace(/\s*\n\s*/gu, ' ↵ ').trim();
}

function safeOneLineJson(value: unknown): string {
  try {
    return oneLine(JSON.stringify(value));
  } catch {
    return '[unserializable arguments]';
  }
}

function visibleCharacterCount(value: string): number {
  return Array.from(sanitizeStreamingText(value).replace(/\n/gu, '')).length;
}

function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
