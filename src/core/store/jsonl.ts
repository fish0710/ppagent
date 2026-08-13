import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type {
  SessionId,
  SessionMeta,
  Store,
  StoreRecord,
} from '../types.js';

export interface JsonlStoreOptions {
  rootDirectory: string;
  now?: () => number;
}

/** 每个 session 一个目录；records.jsonl 只追加，meta.json 可原子替换。 */
export class JsonlStore implements Store {
  readonly #rootDirectory: string;
  readonly #now: () => number;
  readonly #queues = new Map<SessionId, Promise<void>>();

  constructor(options: JsonlStoreOptions) {
    if (options.rootDirectory.trim().length === 0) {
      throw new Error('rootDirectory must not be empty');
    }
    this.#rootDirectory = options.rootDirectory;
    this.#now = options.now ?? Date.now;
  }

  async create(
    meta: Omit<SessionMeta, 'createdAt' | 'updatedAt'>,
  ): Promise<void> {
    validateSessionId(meta.id);
    await mkdir(this.#rootDirectory, { recursive: true });
    const directory = this.#sessionDirectory(meta.id);
    await mkdir(directory);
    const timestamp = this.#now();
    const complete: SessionMeta = {
      ...meta,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await Promise.all([
      writeFile(join(directory, 'meta.json'), `${JSON.stringify(complete)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      }),
      writeFile(join(directory, 'records.jsonl'), '', {
        encoding: 'utf8',
        flag: 'wx',
      }),
    ]);
  }

  async append(id: SessionId, record: StoreRecord): Promise<void> {
    validateSessionId(id);
    await this.#enqueue(id, async () => {
      await appendFile(
        this.#recordsPath(id),
        `${JSON.stringify(record)}\n`,
        'utf8',
      );
      await this.#updateMeta(id, {});
    });
  }

  async load(id: SessionId): Promise<StoreRecord[]> {
    validateSessionId(id);
    await this.#queues.get(id);
    const text = await readFile(this.#recordsPath(id), 'utf8');
    const records = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) => parseRecord(line, index + 1));
    return records.sort((left, right) => left.seq - right.seq);
  }

  async list(): Promise<SessionMeta[]> {
    await Promise.all(this.#queues.values());
    let entries;
    try {
      entries = await readdir(this.#rootDirectory, { withFileTypes: true });
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return [];
      throw error;
    }
    const metas = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('session-'))
        .map(async (entry) =>
          parseMeta(
            await readFile(join(this.#rootDirectory, entry.name, 'meta.json'), 'utf8'),
          ),
        ),
    );
    return metas.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async touch(id: SessionId, patch: Partial<SessionMeta>): Promise<void> {
    validateSessionId(id);
    await this.#enqueue(id, () => this.#updateMeta(id, patch));
  }

  async #updateMeta(
    id: SessionId,
    patch: Partial<SessionMeta>,
  ): Promise<void> {
    const path = this.#metaPath(id);
    const current = parseMeta(await readFile(path, 'utf8'));
    const updated: SessionMeta = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: this.#now(),
    };
    const temporary = `${path}.tmp-${process.pid}-${this.#now()}`;
    await writeFile(temporary, `${JSON.stringify(updated)}\n`, 'utf8');
    await rename(temporary, path);
  }

  async #enqueue<T>(id: SessionId, action: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const marker = run.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(id, marker);
    try {
      return await run;
    } finally {
      if (this.#queues.get(id) === marker) this.#queues.delete(id);
    }
  }

  #sessionDirectory(id: SessionId): string {
    return join(this.#rootDirectory, `session-${encodeURIComponent(id)}`);
  }

  #metaPath(id: SessionId): string {
    return join(this.#sessionDirectory(id), 'meta.json');
  }

  #recordsPath(id: SessionId): string {
    return join(this.#sessionDirectory(id), 'records.jsonl');
  }
}

function parseRecord(line: string, lineNumber: number): StoreRecord {
  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSONL record at line ${lineNumber}: ${errorMessage(error)}`);
  }
  if (!isRecord(value) || !Number.isInteger(value['seq'])) {
    throw new Error(`Invalid store record at line ${lineNumber}`);
  }
  if (value['kind'] !== 'message' && value['kind'] !== 'compaction') {
    throw new Error(`Invalid store record kind at line ${lineNumber}`);
  }
  return value as unknown as StoreRecord;
}

function parseMeta(text: string): SessionMeta {
  const value = JSON.parse(text) as unknown;
  if (
    !isRecord(value) ||
    typeof value['id'] !== 'string' ||
    typeof value['cwd'] !== 'string' ||
    typeof value['createdAt'] !== 'number' ||
    typeof value['updatedAt'] !== 'number'
  ) {
    throw new Error('Invalid session metadata');
  }
  return value as unknown as SessionMeta;
}

function validateSessionId(id: SessionId): void {
  if (id.trim().length === 0) throw new Error('Session id must not be empty');
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
