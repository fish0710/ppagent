import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(fileURLToPath(import.meta.url));

describe('M0 smoke', () => {
  it('测试框架可用', () => {
    expect(1 + 1).toBe(2);
  });

  it('core/types.ts 存在且不 import 任何模块', () => {
    const src = readFileSync(join(ROOT, '..', 'src', 'core', 'types.ts'), 'utf-8');
    expect(src.trim().length).toBeGreaterThan(0);
    expect(src).not.toMatch(/^\s*import\s/m);
  });

  it('package.json 为 type: module', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, '..', 'package.json'), 'utf-8'),
    ) as { type?: string };
    expect(pkg.type).toBe('module');
  });
});
