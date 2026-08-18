import { describe, expect, it } from 'vitest';
import {
  assembleSummary,
  getSection,
  mergeCarriedSection,
  parseSummarySections,
} from '../src/agent/summarize/sections.js';

describe('parseSummarySections', () => {
  it('splits on ## headings and trims each body', () => {
    const parsed = parseSummarySections(
      '## Goal\nship the retry helper\n\n## Next steps\nadd tests\n',
    );
    expect(parsed.matched).toBe(true);
    expect(getSection(parsed, 'Goal')).toBe('ship the retry helper');
    expect(getSection(parsed, 'Next steps')).toBe('add tests');
  });

  it('is case- and colon-insensitive on heading lookup', () => {
    const parsed = parseSummarySections('## key decisions:\nuse exponential backoff');
    expect(getSection(parsed, 'Key decisions')).toBe('use exponential backoff');
  });

  it('discards a preamble before the first heading instead of failing to parse', () => {
    const parsed = parseSummarySections(
      'Sure, here is the summary:\n## Goal\nship it\n',
    );
    expect(parsed.matched).toBe(true);
    expect(getSection(parsed, 'Goal')).toBe('ship it');
  });

  it('reports matched:false for text with no headings at all', () => {
    // 这是 StructuralSummarizer 兜底产出的形态，也是模型完全不守格式的形态。
    const parsed = parseSummarySections('Compacted conversation history:\nuser: hi\n');
    expect(parsed.matched).toBe(false);
    expect(getSection(parsed, 'Goal')).toBe('');
  });

  it('returns an empty string for a heading that never appeared', () => {
    const parsed = parseSummarySections('## Goal\nx');
    expect(getSection(parsed, 'Key decisions')).toBe('');
  });
});

describe('mergeCarriedSection', () => {
  it('keeps carried lines verbatim and appends new ones after them', () => {
    const merged = mergeCarriedSection(
      '- no new dependencies',
      '- must support Node 22',
    );
    expect(merged).toBe('- no new dependencies\n- must support Node 22');
  });

  it('drops duplicates that differ only in case or leading/trailing whitespace', () => {
    const merged = mergeCarriedSection(
      '- no new dependencies',
      '  - No New Dependencies  \n- must support Node 22',
    );
    expect(merged).toBe('- no new dependencies\n- must support Node 22');
  });

  it('lets through near-duplicates that differ by internal whitespace — dedup is exact, not fuzzy', () => {
    // 精确字符串去重，近似重复放过：宁可轻微冗余，也不猜哪些"看起来一样"的行
    // 其实是同一条约束——猜错了会误删真正不同的两条。
    const merged = mergeCarriedSection('- no new dependencies', '-   no  new dependencies');
    expect(merged).toBe('- no new dependencies\n-   no  new dependencies');
  });

  it('never drops a carried line even if the model repeats or omits it', () => {
    const merged = mergeCarriedSection('- keep this forever', '');
    expect(merged).toBe('- keep this forever');
  });

  it('returns the incoming lines untouched when nothing was carried', () => {
    expect(mergeCarriedSection('', '- first constraint')).toBe('- first constraint');
  });
});

describe('assembleSummary', () => {
  it('orders sections goal/constraints/next-steps/decisions/facts/files/done', () => {
    const text = assembleSummary({
      goal: 'ship retry',
      constraints: '- no new deps',
      nextSteps: 'write tests',
      keyDecisions: '- use backoff: avoids thundering herd',
      facts: 'entrypoint is src/fetch.ts',
      fileOpsText: '<files-modified>\nsrc/fetch.ts\n</files-modified>',
      done: 'implemented retry logic',
    });
    const order = [
      '## Goal',
      '## Constraints & preferences',
      '## Next steps',
      '## Key decisions',
      '## Facts to carry forward',
      '<files-modified>',
      '## Done',
    ];
    let cursor = -1;
    for (const marker of order) {
      const at = text.indexOf(marker);
      expect(at, `expected to find ${marker}`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('omits empty optional sections entirely instead of printing an empty heading', () => {
    const text = assembleSummary({
      goal: 'x',
      constraints: '',
      nextSteps: 'y',
      keyDecisions: '',
      facts: '',
      fileOpsText: '',
      done: '',
    });
    expect(text).not.toContain('Constraints');
    expect(text).not.toContain('Key decisions');
    expect(text).not.toContain('Facts');
    expect(text).not.toContain('Done');
  });

  it('places earlier-context ahead of Goal when the old summary could not be parsed', () => {
    const text = assembleSummary({
      goal: 'ship retry',
      constraints: '',
      nextSteps: 'y',
      keyDecisions: '',
      facts: '',
      fileOpsText: '',
      done: '',
      earlierContext: 'Compacted conversation history:\nuser: hi',
    });
    expect(text.indexOf('Earlier context')).toBeLessThan(text.indexOf('## Goal'));
    expect(text).toContain('Compacted conversation history:');
  });

  it('round-trips through parseSummarySections so carry-forward keeps working across compactions', () => {
    const text = assembleSummary({
      goal: 'x',
      constraints: '- no new deps',
      nextSteps: 'y',
      keyDecisions: '- use backoff',
      facts: 'z',
      fileOpsText: '',
      done: 'w',
    });
    const reparsed = parseSummarySections(text);
    expect(getSection(reparsed, 'Constraints & preferences')).toBe('- no new deps');
    expect(getSection(reparsed, 'Key decisions')).toBe('- use backoff');
  });
});
