/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'core-no-upward',
      severity: 'error',
      comment: 'core/ 不得 import agent/ 或 app/',
      from: { path: '^src/core' },
      to: { path: '^src/(agent|app)' },
    },
    {
      name: 'agent-no-app',
      severity: 'error',
      comment: 'agent/ 不得 import app/',
      from: { path: '^src/agent' },
      to: { path: '^src/app' },
    },
    {
      name: 'types-is-leaf',
      severity: 'error',
      comment: 'core/types.ts 是纯类型叶子节点，不得 import 任何模块',
      from: { path: '^src/core/types\\.ts$' },
      to: { pathNot: '^$' },
    },
    {
      name: 'pi-ai-only-in-adapter',
      severity: 'error',
      comment: 'pi-ai 的第三方类型只能在 core/llm/pi-ai.ts 里出现',
      from: { path: '^src/core', pathNot: '^src/core/llm/pi-ai\\.ts$' },
      to: { path: 'node_modules/@earendil-works/pi-ai' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    // 关键：扫 import type。TS 会把类型 import 擦除，默认只看编译后依赖会让
    // types-is-leaf 和 pi-ai-only-in-adapter 完全失效——而类型泄漏的形态恰恰
    // 几乎必然是 import type。
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
