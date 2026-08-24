import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { LoopEndReason, Millis, SessionId } from '../../core/types.js';

/**
 * 一次 prompt() 调用的采纳反馈，一行一条，append-only（同 core/store/jsonl.ts
 * 的 records.jsonl 先例）。粒度是"一次会话"而不是"一条记忆"：四个指标
 * （采纳率、采纳后成功率、步数差、cold 率）里，步数差需要按会话关联
 * turns 和是否采纳，聚合在记录级别上做不到，必须留一条按会话切片的原始
 * 事件；其余三个指标可以从这条事件流聚合出来，不需要再多开一条流。
 *
 * 不走 telemetry（core/telemetry/）：Span 是旁路语义，可采样、可丢弃、
 * exporter 失败不改变任务结果；这份数据要用来算指标，丢一条就会让统计
 * 有偏，语义上不是"旁路"，不能共用那条通道。
 */
export interface MemoryUsageLogEntry {
  timestamp: Millis;
  sessionId: SessionId;
  /** 本次会话注入 systemPrompt 的记忆 id；空数组表示这次没有任何记忆入选。 */
  injectedIds: string[];
  /** injectedIds 的子集：detectAdoption 判定为用到了的那些。 */
  adoptedIds: string[];
  loopEndReason: LoopEndReason;
  turns: number;
}

/** 行为契约：session.ts 只依赖这个接口，测试可以注入不落盘的假实现。 */
export interface MemoryUsageLog {
  append(entry: MemoryUsageLogEntry): Promise<void>;
  /** 供离线聚合脚本 / 未来的指标面板使用；不在运行时热路径上。 */
  readAll(): Promise<MemoryUsageLogEntry[]>;
}

export interface MemoryUsageLogOptions {
  /** 与 records.json 同目录；resume 路径不写这份日志（见 agent/session.ts 的注释）。 */
  rootDirectory: string;
}

export class JsonlMemoryUsageLog implements MemoryUsageLog {
  readonly #path: string;

  constructor(options: MemoryUsageLogOptions) {
    this.#path = join(options.rootDirectory, 'usage.jsonl');
  }

  async append(entry: MemoryUsageLogEntry): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async readAll(): Promise<MemoryUsageLogEntry[]> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as MemoryUsageLogEntry);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
