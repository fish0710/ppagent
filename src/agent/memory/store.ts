import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryRecord, MemoryStore } from '../../core/types.js';

export interface JsonlMemoryStoreOptions {
  rootDirectory: string;
  now?: () => number;
}

/**
 * 单文件 records.json，整份原子替换（tmp + rename）。
 *
 * 不用 core/store/jsonl.ts 的按行追加形状：那个形状是为 append-only 的会话
 * 历史设计的，记忆可更新可删除（错题本 1.3），追加流不适用。v1 记忆量在
 * 数百条级别，一次性读入内存排序足够；量级涨上去后再考虑索引化，不必现在
 * 就为此让接口复杂化。
 *
 * 单实例只对应一个目录，即一个 scope（project 或 user 各自的 rootDirectory）。
 * 该把一条记忆写进哪个目录，由调用方按 record.scope 决定 —— 见
 * src/agent/memory/index.ts 的 writeMemoryRecord。
 */
export class JsonlMemoryStore implements MemoryStore {
  readonly #rootDirectory: string;
  readonly #now: () => number;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: JsonlMemoryStoreOptions) {
    if (options.rootDirectory.trim().length === 0) {
      throw new Error('rootDirectory must not be empty');
    }
    this.#rootDirectory = options.rootDirectory;
    this.#now = options.now ?? Date.now;
  }

  async put(record: MemoryRecord): Promise<void> {
    await this.#mutate((records) => [
      ...records.filter((existing) => existing.id !== record.id),
      record,
    ]);
  }

  async all(): Promise<MemoryRecord[]> {
    // 等待队列中的写入落盘，读到的才是最新视图 —— 同 JsonlStore.list() 的先例。
    await this.#queue;
    return this.#read();
  }

  async patch(id: string, patch: Partial<MemoryRecord>): Promise<void> {
    await this.#mutate((records) => {
      let found = false;
      const next = records.map((existing) => {
        if (existing.id !== id) return existing;
        found = true;
        // id 不可被 patch 覆盖，防止调用方传入的 patch 里意外带了别的 id。
        return { ...existing, ...patch, id: existing.id };
      });
      if (!found) throw new Error(`Unknown memory record: ${id}`);
      return next;
    });
  }

  async remove(id: string): Promise<void> {
    await this.#mutate((records) => records.filter((existing) => existing.id !== id));
  }

  /**
   * 单队列串行化读-改-写。记忆量小、单文件，不需要 JsonlStore 那种按 session
   * id 分队列的形状；失败不阻塞后续操作 —— 队列节点无论成败都归一为
   * resolved，同 JsonlStore.#enqueue 的先例。
   */
  async #mutate(transform: (records: MemoryRecord[]) => MemoryRecord[]): Promise<void> {
    const run = this.#queue.catch(() => undefined).then(async () => {
      const current = await this.#read();
      await this.#write(transform(current));
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  async #read(): Promise<MemoryRecord[]> {
    let text: string;
    try {
      text = await readFile(this.#path(), 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    if (text.trim().length === 0) return [];
    const value = JSON.parse(text) as unknown;
    if (!Array.isArray(value)) {
      throw new Error('Invalid memory store file: expected a JSON array');
    }
    return value.map((entry, index) => parseRecord(entry, index));
  }

  async #write(records: MemoryRecord[]): Promise<void> {
    await mkdir(this.#rootDirectory, { recursive: true });
    const path = this.#path();
    const temporary = `${path}.tmp-${process.pid}-${this.#now()}`;
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  }

  #path(): string {
    return join(this.#rootDirectory, 'records.json');
  }
}

function parseRecord(value: unknown, index: number): MemoryRecord {
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    (value['scope'] !== 'project' && value['scope'] !== 'user') ||
    typeof value['text'] !== 'string'
  ) {
    throw new Error(`Invalid memory record at index ${index}`);
  }
  return value as unknown as MemoryRecord;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
