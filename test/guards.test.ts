// 项目级 harness 守卫测试（对应 AGENTS.md 的 Hard constraints / Agent Notes）。
//
// 纪律：每条守卫必须同时证明自己能拒绝坏输入 —— 只断言真实源码"通过"不够，
// 一个写错的正则会永远"通过"，门禁就退化成安慰剂。所以每条规则都拆成一个
// 纯函数，对真实源码断言一次，再对一段已知违规的字符串常量断言一次。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf-8');
}

// ---------------------------------------------------------------------------
// core/types.ts 是依赖图叶子节点：不得 import 任何模块（含 import type）。
// ---------------------------------------------------------------------------

function hasTopLevelImport(src: string): boolean {
  return /^\s*import\s/mu.test(src);
}

describe('core/types.ts 是纯类型叶子节点', () => {
  it('真实源码不含 import', () => {
    expect(hasTopLevelImport(read('src/core/types.ts'))).toBe(false);
  });

  it('规则本身能识别违规写法', () => {
    expect(hasTopLevelImport("import type { X } from './x.js';\n")).toBe(true);
    expect(hasTopLevelImport("import { readFile } from 'node:fs';\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// core/context/tokenizer.ts 保持纯计算：不得做文件/网络 IO。
// ---------------------------------------------------------------------------

function doesIo(src: string): boolean {
  return (
    /from ['"]node:(?:fs|path)/u.test(src) ||
    src.includes('@huggingface/tokenizers') ||
    /\bfetch\s*\(/u.test(src)
  );
}

describe('core/context/tokenizer.ts 不直接执行文件或网络 IO', () => {
  it('真实源码不做 IO', () => {
    expect(doesIo(read('src/core/context/tokenizer.ts'))).toBe(false);
  });

  it('规则本身能识别违规写法', () => {
    expect(doesIo("import { readFileSync } from 'node:fs';\n")).toBe(true);
    expect(doesIo('await fetch(url);\n')).toBe(true);
    expect(doesIo("import { load } from '@huggingface/tokenizers';\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// core/ 任何文件不得读配置文件或环境变量（设计书 §3 第 5 条）；配置由构造
// 参数传入，见 agent/config/。dependency-cruiser 管不到 process.env 读取，
// 这条只能靠源码扫描。
// ---------------------------------------------------------------------------

function readsProcessEnv(src: string): boolean {
  return /\bprocess\.env\b/u.test(src);
}

function listCoreFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const relPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(relPath);
      else if (entry.name.endsWith('.ts')) files.push(relPath);
    }
  };
  walk('src/core');
  return files;
}

describe('core/ 不得读环境变量', () => {
  it('真实源码零命中', () => {
    const offenders = listCoreFiles().filter((path) => readsProcessEnv(read(path)));
    expect(offenders).toEqual([]);
  });

  it('规则本身能识别违规写法', () => {
    expect(readsProcessEnv("const key = process.env.API_KEY;\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// bash 工具的子进程必须用独立进程组启动，否则取消只能杀 shell 本身，
// 孙进程被 init 收养继续跑（错题本 1.6，实测复现过的孤儿进程回归）。
// ---------------------------------------------------------------------------

function spawnsDetached(src: string): boolean {
  const spawnCall = /spawn\([^)]*\{[^}]*\}\s*\)/su.exec(src);
  if (spawnCall === null) return false;
  return /detached\s*:\s*true/u.test(spawnCall[0]);
}

describe('bash 工具子进程使用独立进程组', () => {
  it('真实源码传了 detached: true', () => {
    expect(spawnsDetached(read('src/core/tools/builtin/bash.ts'))).toBe(true);
  });

  it('规则本身能识别违规写法', () => {
    expect(spawnsDetached("spawn(cmd, args, { stdio: 'pipe' })")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AGENTS.md 会被注入系统提示词；本项目的立项理由之一就是提示词要小
// （本地模型有效上下文有限），所以给它一个硬性行数上限。
// ---------------------------------------------------------------------------

const AGENTS_MD_LINE_LIMIT = 140;

describe('AGENTS.md 文档预算', () => {
  it('存在且不超过行数上限', () => {
    const lines = read('AGENTS.md').split('\n');
    expect(lines.length).toBeLessThanOrEqual(AGENTS_MD_LINE_LIMIT);
  });
});

// ---------------------------------------------------------------------------
// docs/notes/ 下的 Agent Note 必须遵守固定头部格式，且 Alternatives
// considered 强制必填 —— 没写清楚被否决的方案，决策会被反复重提。
// ---------------------------------------------------------------------------

const NOTE_HEADER = /^# Agent Note: .+\n\nStatus: (proposed|implemented|rejected — .+)\n/u;

function violatesNoteFormat(src: string): string | undefined {
  if (!NOTE_HEADER.test(src)) return 'missing header block';
  if (!src.includes('## Problem')) return 'missing ## Problem';
  if (!src.includes('## Alternatives considered')) return 'missing ## Alternatives considered';
  return undefined;
}

describe('docs/notes/ Agent Note 格式', () => {
  const noteFiles = readdirSync(join(ROOT, 'docs/notes')).filter(
    (name) => name.endsWith('.md') && name !== 'README.md',
  );

  it('至少存在一份 Agent Note', () => {
    expect(noteFiles.length).toBeGreaterThan(0);
  });

  it.each(noteFiles)('%s 符合格式要求', (name) => {
    const violation = violatesNoteFormat(read(join('docs/notes', name)));
    expect(violation).toBeUndefined();
  });

  it('规则本身能识别违规写法', () => {
    expect(violatesNoteFormat('# Agent Note: x\n\nStatus: implemented\n\n## Decision\n')).toBe(
      'missing ## Problem',
    );
    expect(
      violatesNoteFormat('# Agent Note: x\n\nStatus: implemented\n\n## Problem\n## Decision\n'),
    ).toBe('missing ## Alternatives considered');
    expect(violatesNoteFormat('no header at all')).toBe('missing header block');
  });
});
