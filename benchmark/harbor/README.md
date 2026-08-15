# Harbor / Terminal-Bench adapter

`PPAgent` is a Harbor installed agent. It installs this repository inside each task
container, runs the stable `--json` protocol, and derives token/resource metadata from
`turn_end`, `admission_denied`, `compacted`, and `loop_end` events.

Local servers on the macOS host must be addressed through `host.docker.internal`:

Run Harbor with the repository on `PYTHONPATH`; Harbor changes cwd before it imports a
custom agent class:

```bash
PYTHONPATH="$(pwd)" harbor run -d terminal-bench@2.0 \
  -a benchmark.harbor.ppagent:PPAgent \
  -m lmstudio/qwen3.6-27b \
  --ae PPAGENT_CUSTOM_BASE_URL=http://host.docker.internal:1234/v1 \
  --ae PPAGENT_TOKENIZER=/tokenizer \
  --allow-agent-host host.docker.internal \
  --mounts '[{"type":"bind","source":"/absolute/path/to/tokenizer","target":"/tokenizer","read_only":true}]' \
  -n 1
```

Tokenizer loading is offline by default. The example mounts a directory containing
`tokenizer.json` and `tokenizer_config.json`; a benchmark must not acquire a hidden
Hugging Face network dependency merely because its model server is local.

The adapter deliberately passes `--permission-mode allow`: Harbor already isolates each
task in its own container. Normal PPAgent CLI runs remain interactive/default-deny.

For an unpushed checkout, mount it into the task and pass `source_path`:

```bash
PYTHONPATH="$(pwd)" harbor run ... \
  --mounts '[{"type":"bind","source":"/absolute/path/to/ppagent","target":"/ppagent-source","read_only":true}]' \
  --ak source_path=/ppagent-source
```

The local-source install excludes `.git`, `dist`, and `node_modules`, performs
`npm ci --ignore-scripts`, and rebuilds in the container. This avoids repository-only
Git hook setup and does not copy host-native dependencies into a Linux task.

## Smoke and comparison

The adapter was exercised end to end against one `terminal-bench@2.0` task with the
`faux/faux-model` protocol fixture: one trial reached the verifier with no Harbor
exception and produced `events.jsonl` plus PPAgent metadata. Its reward is expected to
be zero—the faux model validates the adapter, not task-solving quality.

For a real comparison, pin the same dataset version, task filters, endpoint, model, and
attempt count in two Harbor jobs: one with this adapter and one with Harbor's built-in
`pi` agent. Keep the result directories separate, then compare reward, token counts,
runtime, admission denials, and compaction counts. Run PPAgent's compatibility probe
before either job whenever the server model or chat template changes:

```bash
PPAGENT_CUSTOM_BASE_URL=http://localhost:1234/v1 \
PPAGENT_CUSTOM_API_KEY="$LM_API_TOKEN" \
node bin/agent.js --check-compat --provider lmstudio --model qwen3.6-27b
```
