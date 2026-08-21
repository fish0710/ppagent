import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = dirname(fileURLToPath(import.meta.url));

describe('M0 smoke', () => {
  it('测试框架可用', () => {
    expect(1 + 1).toBe(2);
  });

  it('package.json 为 type: module', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, '..', 'package.json'), 'utf-8'),
    ) as { type?: string };
    expect(pkg.type).toBe('module');
  });
});

// 源码守卫断言（core/types.ts 无 import、tokenizer.ts 无 IO 等）已迁到
// test/guards.test.ts，与项目级 harness 的其余不变量放在一起维护。
