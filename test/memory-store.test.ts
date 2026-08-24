import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  allMemoryRecords,
  retrieveMemoryBlock,
  writeMemoryRecord,
  type MemoryStores,
} from '../src/agent/memory/index.js';
import { deriveProjectKey } from '../src/agent/memory/project-key.js';
import { JsonlMemoryStore } from '../src/agent/memory/store.js';
import { O200kTokenCounter } from '../src/core/context/tokenizer.js';
import type { MemoryConfig, MemoryRecord } from '../src/core/types.js';

const execFileAsync = promisify(execFile);

describe('JsonlMemoryStore', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  async function newRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'ppagent-memory-'));
    roots.push(root);
    return root;
  }

  it('persists put across store instances', async () => {
    const root = await newRoot();
    const store = new JsonlMemoryStore({ rootDirectory: root });
    await store.put(record({ id: 'm1', text: 'always run npm run verify before commit' }));

    const reopened = new JsonlMemoryStore({ rootDirectory: root });
    expect(await reopened.all()).toEqual([
      expect.objectContaining({ id: 'm1', text: 'always run npm run verify before commit' }),
    ]);
  });

  it('starts empty when no file has been written yet', async () => {
    const root = await newRoot();
    const store = new JsonlMemoryStore({ rootDirectory: root });
    expect(await store.all()).toEqual([]);
  });

  it('put replaces an existing record with the same id rather than duplicating it', async () => {
    const root = await newRoot();
    const store = new JsonlMemoryStore({ rootDirectory: root });
    await store.put(record({ id: 'm1', text: 'first version' }));
    await store.put(record({ id: 'm1', text: 'second version' }));

    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]?.text).toBe('second version');
  });

  it('patch merges fields and refuses to let the patch override id', async () => {
    const root = await newRoot();
    const store = new JsonlMemoryStore({ rootDirectory: root });
    await store.put(record({ id: 'm1', exposure: 0 }));
    await store.patch('m1', { exposure: 3, id: 'm2' } as Partial<MemoryRecord>);

    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'm1', exposure: 3 });
  });

  it('patch on an unknown id throws rather than silently no-op', async () => {
    const root = await newRoot();
    const store = new JsonlMemoryStore({ rootDirectory: root });
    await expect(store.patch('missing', { exposure: 1 })).rejects.toThrow(
      /Unknown memory record/,
    );
  });

  it('remove deletes the record and is a no-op for unknown ids', async () => {
    const root = await newRoot();
    const store = new JsonlMemoryStore({ rootDirectory: root });
    await store.put(record({ id: 'm1' }));
    await store.remove('m1');
    expect(await store.all()).toEqual([]);
    await expect(store.remove('m1')).resolves.toBeUndefined();
  });

  it('serializes concurrent mutations without losing writes', async () => {
    const root = await newRoot();
    const store = new JsonlMemoryStore({ rootDirectory: root });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.put(record({ id: `m${index}`, text: `memory ${index}` })),
      ),
    );
    const all = await store.all();
    expect(all).toHaveLength(20);
    expect(new Set(all.map((entry) => entry.id)).size).toBe(20);
  });

  it('rejects an empty rootDirectory', () => {
    expect(() => new JsonlMemoryStore({ rootDirectory: '  ' })).toThrow(
      /rootDirectory must not be empty/,
    );
  });
});

describe('scope routing', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it('routes project-scope records and user-scope records to their own store', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ppagent-memory-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ppagent-memory-user-'));
    roots.push(projectRoot, userRoot);
    const stores: MemoryStores = {
      project: new JsonlMemoryStore({ rootDirectory: projectRoot }),
      user: new JsonlMemoryStore({ rootDirectory: userRoot }),
    };

    await writeMemoryRecord(stores, record({ id: 'p1', scope: 'project' }));
    await writeMemoryRecord(stores, record({ id: 'u1', scope: 'user' }));

    expect((await stores.project.all()).map((entry) => entry.id)).toEqual(['p1']);
    expect((await stores.user.all()).map((entry) => entry.id)).toEqual(['u1']);
    expect((await allMemoryRecords(stores)).map((entry) => entry.id).sort()).toEqual([
      'p1',
      'u1',
    ]);
  });
});

describe('retrieveMemoryBlock (full pipeline: store -> rank -> render)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it('retrieves matching records from disk, ranks them, and renders them within budget', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ppagent-memory-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ppagent-memory-user-'));
    roots.push(projectRoot, userRoot);
    const stores: MemoryStores = {
      project: new JsonlMemoryStore({ rootDirectory: projectRoot }),
      user: new JsonlMemoryStore({ rootDirectory: userRoot }),
    };
    await writeMemoryRecord(
      stores,
      record({
        id: 'relevant',
        scope: 'project',
        text: 'always run npm run verify before committing',
      }),
    );
    await writeMemoryRecord(
      stores,
      record({ id: 'unrelated', scope: 'project', text: 'the sandbox denies network by default' }),
    );
    await writeMemoryRecord(
      stores,
      record({ id: 'other-project', scope: 'project', projectKey: 'other', text: 'commit convention' }),
    );

    const { text, included } = await retrieveMemoryBlock(
      stores,
      { text: 'what should I run npm verify before commit', projectKey: 'proj' },
      memoryConfig(),
      new O200kTokenCounter(),
    );

    expect(text).toContain('npm run verify');
    expect(text).not.toContain('sandbox denies network');
    expect(text).not.toContain('commit convention');
    expect(text).toContain('<long-term-memory>');
    expect(included.map((r) => r.id)).toEqual(['relevant']);
  });

  it('returns an empty string when nothing is stored yet', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ppagent-memory-project-'));
    const userRoot = await mkdtemp(join(tmpdir(), 'ppagent-memory-user-'));
    roots.push(projectRoot, userRoot);
    const stores: MemoryStores = {
      project: new JsonlMemoryStore({ rootDirectory: projectRoot }),
      user: new JsonlMemoryStore({ rootDirectory: userRoot }),
    };
    const { text, included } = await retrieveMemoryBlock(
      stores,
      { text: 'anything', projectKey: 'proj' },
      memoryConfig(),
      new O200kTokenCounter(),
    );
    expect(text).toBe('');
    expect(included).toEqual([]);
  });
});

function memoryConfig(overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return {
    enabled: true,
    injectMaxTokens: 400,
    minScore: 0.1,
    slotProject: 2,
    slotUser: 1,
    slotExplore: 0,
    extractMaxTokens: 512,
    extractTimeoutMs: 60_000,
    searchTool: false,
    ...overrides,
  };
}

describe('deriveProjectKey', () => {
  it('prefers the git remote origin URL when the cwd is inside a repo with one', async () => {
    // 这个仓库自己就是带 remote 的 git repo，直接拿真实值当 fixture 用，
    // 不需要额外搭一个临时仓库。
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: process.cwd(),
    }).catch(() => ({ stdout: '' }));
    const expectedRemote = stdout.trim();
    if (expectedRemote.length === 0) return; // 环境没配 remote 时跳过，不是本函数的失败

    expect(await deriveProjectKey(process.cwd())).toBe(expectedRemote);
  });

  it('falls back to the realpath of cwd outside any git repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ppagent-not-a-repo-'));
    try {
      expect(await deriveProjectKey(root)).toBe(await realpathOf(root));
    } finally {
      await rm(root, { recursive: true });
    }
  });
});

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(path);
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'm1',
    scope: 'project',
    kind: 'fact',
    text: 'placeholder memory text',
    projectKey: 'proj',
    sourceSessionId: 'session-1',
    createdAt: 0,
    updatedAt: 0,
    status: 'active',
    exposure: 0,
    adopted: 0,
    adoptedOk: 0,
    adoptedBad: 0,
    ...overrides,
  };
}
