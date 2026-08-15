"""Harbor 0.20 installed-agent adapter for PPAgent.

Run with:
  harbor run -d terminal-bench@2.0 \
    -a benchmark.harbor.ppagent:PPAgent \
    -m lmstudio/qwen3.6-27b \
    --ae PPAGENT_CUSTOM_BASE_URL=http://host.docker.internal:1234/v1 \
    --allow-agent-host host.docker.internal
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    CliFlag,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


class PPAgent(BaseInstalledAgent):
    """Install PPAgent in the task container and consume its stable NDJSON UIEvent stream."""

    _EVENTS_FILENAME = "ppagent/events.jsonl"
    _STDERR_FILENAME = "ppagent/stderr.log"
    # BaseInstalledAgent 以普通用户安装；不要依赖 /opt 等 root 所有目录。
    _INSTALL_DIR = "$HOME/.local/share/ppagent"

    CLI_FLAGS = [
        CliFlag("max_turns", cli="--max-turns", type="int", default=32),
    ]

    def __init__(
        self,
        logs_dir: Path,
        source_url: str = "https://github.com/fish0710/ppagent.git",
        source_ref: str | None = None,
        source_path: str | None = None,
        *args,
        **kwargs,
    ) -> None:
        super().__init__(logs_dir, *args, **kwargs)
        self._source_url = source_url
        self._source_ref = source_ref
        self._source_path = source_path

    @staticmethod
    @override
    def name() -> str:
        return "ppagent"

    @override
    def get_version_command(self) -> str | None:
        return f'. ~/.nvm/nvm.sh; node {self._INSTALL_DIR}/bin/agent.js --version'

    @override
    def parse_version(self, stdout: str) -> str:
        return stdout.strip().splitlines()[-1].strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        required_tools = (
            "command -v curl >/dev/null"
            if self._source_path
            else "command -v curl >/dev/null && command -v git >/dev/null"
        )
        packages = "ca-certificates curl" if self._source_path else "ca-certificates curl git"
        await self.exec_as_root(
            environment,
            # Terminal-Bench 基础镜像通常已有这些工具；避免每个 trial 都做一次
            # 昂贵的 apt 索引刷新。缺失时才安装。
            command=(
                f"{required_tools} || "
                f"(apt-get update && apt-get install -y {packages})"
            ),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        if self._source_path:
            source = shlex.quote(self._source_path)
            acquire = (
                f'rm -rf {self._INSTALL_DIR} && '
                f'mkdir -p {self._INSTALL_DIR} && '
                # 本地 worktree 常含庞大的 node_modules/dist；容器内必须 npm ci/build。
                f"tar -C {source} --exclude=.git --exclude=node_modules "
                f"--exclude=dist -cf - . | tar -C {self._INSTALL_DIR} -xf -"
            )
        else:
            branch = (
                ""
                if self._source_ref is None
                else f"--branch {shlex.quote(self._source_ref)} "
            )
            acquire = (
                f'rm -rf {self._INSTALL_DIR} && '
                f"git clone --depth 1 {branch}{shlex.quote(self._source_url)} "
                f"{self._INSTALL_DIR}"
            )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                "mkdir -p \"$HOME/.local/share\" && "
                f"{acquire} && "
                # 适配器复制源码时刻意不复制 .git；跳过仅用于仓库 hooks 的 prepare。
                f"cd {self._INSTALL_DIR} && npm ci --ignore-scripts && npm run build && "
                "node bin/agent.js --version"
            ),
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        if not self.model_name or "/" not in self.model_name:
            raise ValueError("Model name must be provider/model_name")
        provider, model = self.model_name.split("/", 1)
        flags = self.build_cli_flags()
        env = {
            key: value
            for key in (
                "PPAGENT_CUSTOM_BASE_URL",
                "PPAGENT_CUSTOM_API_KEY",
                "PPAGENT_TOKENIZER",
                "PPAGENT_TOKENIZER_LOCAL_ONLY",
                "LMNR_PROJECT_API_KEY",
                "PPAGENT_LAMINAR_ENDPOINT",
            )
            if (value := os.environ.get(key))
        }
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; mkdir -p /logs/agent/ppagent; "
                # 保留 Harbor 给任务设置的 cwd；coding agent 必须在任务目录工作。
                ". ~/.nvm/nvm.sh; "
                f"node {self._INSTALL_DIR}/bin/agent.js --json --permission-mode allow "
                f"--provider {shlex.quote(provider)} --model {shlex.quote(model)} "
                f"{flags} {shlex.quote(instruction)} "
                f"2>/logs/agent/{self._STDERR_FILENAME} "
                f"| stdbuf -oL tee /logs/agent/{self._EVENTS_FILENAME}"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        event_file = self.logs_dir / self._EVENTS_FILENAME
        if not event_file.exists():
            return
        input_tokens = 0
        output_tokens = 0
        cache_tokens = 0
        admission_denials = 0
        compactions = 0
        loop_reason: str | None = None
        for raw in event_file.read_text().splitlines():
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "turn_end":
                usage = event.get("usage") or {}
                input_tokens += int(usage.get("input", 0))
                output_tokens += int(usage.get("output", 0))
                cache_tokens += int(usage.get("cacheRead", 0))
            elif event.get("type") == "admission_denied":
                admission_denials += 1
            elif event.get("type") == "compacted":
                compactions += 1
            elif event.get("type") == "loop_end":
                loop_reason = event.get("reason")
        context.n_input_tokens = input_tokens + cache_tokens
        context.n_output_tokens = output_tokens
        context.n_cache_tokens = cache_tokens
        context.cost_usd = 0.0
        context.metadata = {
            "ppagent_loop_reason": loop_reason,
            "ppagent_admission_denials": admission_denials,
            "ppagent_compactions": compactions,
        }
