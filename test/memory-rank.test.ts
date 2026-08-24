import { describe, expect, it } from 'vitest';
import { rankMemories } from '../src/core/memory/rank.js';
import type { MemoryRecord } from '../src/core/types.js';

describe('rankMemories', () => {
  it('prefers records that share vocabulary with the query over unrelated ones', () => {
    const records = [
      record({ id: 'relevant', text: 'run npm run verify before every commit' }),
      record({ id: 'unrelated', text: 'the sandbox denies writes outside the workspace' }),
    ];
    const selected = rankMemories(
      records,
      { text: 'what command should I run before commit', projectKey: 'proj' },
      { slots: { project: 1, user: 0, explore: 0 }, minScore: 0 },
    );
    expect(selected.map((r) => r.id)).toEqual(['relevant']);
  });

  it('excludes project-scope records for a different project', () => {
    const records = [
      record({ id: 'mine', scope: 'project', projectKey: 'proj-a', text: 'commit convention' }),
      record({ id: 'theirs', scope: 'project', projectKey: 'proj-b', text: 'commit convention' }),
    ];
    const selected = rankMemories(
      records,
      { text: 'commit convention', projectKey: 'proj-a' },
      { slots: { project: 2, user: 0, explore: 0 }, minScore: 0 },
    );
    expect(selected.map((r) => r.id)).toEqual(['mine']);
  });

  it('excludes deprecated records entirely', () => {
    const records = [
      record({ id: 'active', status: 'active', text: 'use npm ci in CI' }),
      record({ id: 'dead', status: 'deprecated', text: 'use npm ci in CI' }),
    ];
    const selected = rankMemories(
      records,
      { text: 'npm ci', projectKey: 'proj' },
      { slots: { project: 2, user: 0, explore: 0 }, minScore: 0 },
    );
    expect(selected.map((r) => r.id)).toEqual(['active']);
  });

  it('returns nothing for a slot when every candidate scores below minScore', () => {
    const records = [record({ id: 'm1', text: 'completely unrelated text about weather' })];
    const selected = rankMemories(
      records,
      { text: 'npm run verify typescript build', projectKey: 'proj' },
      { slots: { project: 3, user: 0, explore: 0 }, minScore: 5 },
    );
    expect(selected).toEqual([]);
  });

  it('caps each scope to its own slot size and does not let one scope starve the other', () => {
    const records = [
      record({ id: 'p1', scope: 'project', text: 'npm run verify one' }),
      record({ id: 'p2', scope: 'project', text: 'npm run verify two' }),
      record({ id: 'p3', scope: 'project', text: 'npm run verify three' }),
      record({ id: 'u1', scope: 'user', text: 'npm run verify preference' }),
    ];
    const selected = rankMemories(
      records,
      { text: 'npm run verify', projectKey: 'proj' },
      { slots: { project: 2, user: 1, explore: 0 }, minScore: 0 },
    );
    const projectPicked = selected.filter((r) => r.scope === 'project');
    const userPicked = selected.filter((r) => r.scope === 'user');
    expect(projectPicked).toHaveLength(2);
    expect(userPicked).toHaveLength(1);
  });

  it('MMR avoids selecting near-duplicate records over a slightly lower scoring but distinct one', () => {
    const records = [
      record({ id: 'dup-a', text: 'run npm run verify before committing changes' }),
      record({ id: 'dup-b', text: 'run npm run verify before you commit anything' }),
      record({ id: 'distinct', text: 'the bash tool spawns detached process groups' }),
    ];
    const selected = rankMemories(
      records,
      { text: 'npm run verify commit bash detached process', projectKey: 'proj' },
      { slots: { project: 2, user: 0, explore: 0 }, minScore: 0 },
    );
    const ids = selected.map((r) => r.id);
    expect(ids).toContain('distinct');
    expect(ids.filter((id) => id.startsWith('dup')).length).toBeLessThanOrEqual(1);
  });

  it('explore slot picks the lowest-exposure record, bypassing minScore and the already-picked scored slots', () => {
    const records = [
      record({ id: 'high-score-high-exposure', text: 'npm run verify', exposure: 50 }),
      record({ id: 'low-exposure-unrelated', text: 'totally unrelated weather forecast', exposure: 0 }),
    ];
    const selected = rankMemories(
      records,
      { text: 'npm run verify', projectKey: 'proj' },
      { slots: { project: 1, user: 0, explore: 1 }, minScore: 0 },
    );
    expect(selected.map((r) => r.id)).toEqual([
      'high-score-high-exposure',
      'low-exposure-unrelated',
    ]);
  });

  it('never selects the same record twice across the scored slots and the explore slot', () => {
    const records = [record({ id: 'only', text: 'npm run verify', exposure: 0 })];
    const selected = rankMemories(
      records,
      { text: 'npm run verify', projectKey: 'proj' },
      { slots: { project: 1, user: 0, explore: 1 }, minScore: 0 },
    );
    expect(selected.map((r) => r.id)).toEqual(['only']);
  });

  it('returns an empty array when there are no candidates at all', () => {
    const selected = rankMemories(
      [],
      { text: 'anything', projectKey: 'proj' },
      { slots: { project: 2, user: 1, explore: 1 }, minScore: 0 },
    );
    expect(selected).toEqual([]);
  });
});

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'm1',
    scope: 'project',
    kind: 'fact',
    text: 'placeholder',
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
