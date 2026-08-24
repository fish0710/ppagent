import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * project scope 记忆的归属键：优先取 git remote origin URL —— 跨机器、跨
 * clone 稳定，同一仓库的两份 checkout 应该共享同一个 projectKey。拿不到
 * （没有 git、没有 remote、非仓库目录）时回退 cwd 的 realpath。
 *
 * 不直接用 cwd 字面量：相对路径、符号链接会让字面量比较把同一目录误判成
 * 不同项目。`git remote get-url` 只读本地 git 配置，不发起网络请求，符合
 * 错题本 11.4「本地模型不能默认产生隐藏网络请求」的纪律。
 */
export async function deriveProjectKey(cwd: string): Promise<string> {
  const remote = await readGitRemote(cwd);
  if (remote !== undefined) return remote;
  try {
    return await realpath(cwd);
  } catch {
    return cwd;
  }
}

async function readGitRemote(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch {
    return undefined;
  }
}
