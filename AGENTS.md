# AGENTS.md

ppagent is a coding-agent harness for **locally-deployed models** with native tool calling (e.g. Qwen3.6 on a Mac) — not another cloud-agent CLI. Full design: [docs/agent-开发设计书.md](docs/agent-开发设计书.md).

**Judgment call for any change**: if a decision would matter equally for a cloud frontier model and a local model, it isn't this project's concern — copy the boring, established approach. This project's actual reasons to exist: memory pressure participates in compact decisions, subagent spawn needs GPU admission control, tool execution needs OS-level sandboxing (not prompt-level), and the system prompt must stay small because local context windows are small in practice.

## Repository layout

```
src/core/   pure building blocks — loop, llm, context, tools, sandbox, store, resource, telemetry
src/agent/  assembly + policy — session wiring, config, admission, permissions
src/app/    CLI, TUI, RPC — consumes AgentSession, never core/ directly
bin/        CLI entry (bin/agent.ts), builds to dist/ + bin/*.js
test/       flat *.test.ts mirroring src/ module names; test/guards.test.ts holds source-invariant checks
docs/       architecture (agent-开发设计书.md), lessons (ppagent-错题本.md), decisions (notes/)
benchmark/  Harbor / Terminal-Bench adapter (Python)
probe/      3-task Terminal-Bench calibration/estimation scripts (Python + bash), see probe/README.md
```

## Commands

```sh
npm run verify      # typecheck + depcruise + test — the one command that must pass before you claim done
npm run build       # tsc emits src + bin to dist/ and bin/*.js; CLI requires this
npm run typecheck   # tsc --noEmit over src, bin, and test (test/ is in scope — don't skip it)
npm run depcruise   # architecture rules from .dependency-cruiser.cjs
npm test            # vitest run; npm run test:watch for iteration
```

## Which checks to run when

Match evidence to the surface you touched; don't default to `npm run verify` for a one-line change and don't skip it for a structural one.

- Changed behavior in one module → run that module's `test/<area>.test.ts` directly with vitest.
- Touched `src/core` or `src/agent` import edges → `npm run depcruise` (fast, catches layering violations before CI does).
- Touched TUI rendering → `test/tui.test.ts`, replay against `test/fixtures/tui/*.ndjson`.
- Touched anything published (bin/, package.json exports) → `npm run build`.
- Before a commit that will be pushed, or when unsure → `npm run verify`.
- Report only the commands you actually ran. CI (`.github/workflows/ci.yml`, ubuntu+macos) owns exhaustive coverage — rehearsing the full suite locally for every small change is wasted signal.

## Hard constraints

Enforced by `.dependency-cruiser.cjs` and `test/guards.test.ts` — do not rely on remembering these, but do not weaken the enforcing rule either:

- `core/` never imports `agent/` or `app/`; `agent/` never imports `app/`.
- `core/types.ts` imports nothing (leaf node of the dependency graph).
- Third-party `@earendil-works/pi-ai` types appear only in `src/core/llm/pi-ai.ts`.
- `src/core/context/tokenizer.ts` does no file or network IO.
- `core/` never reads `process.env` or a config file — config is injected via constructor params from `agent/config/`.
- TUI (`src/app/tui`) only consumes `UIEvent`/`Interaction` types and the `AgentSession` port — it does not know about `loop`, `context`, or `tools`.

Full rationale: [docs/agent-开发设计书.md §3](docs/agent-开发设计书.md).

## Conventions

Durable, cross-module rules distilled from [docs/ppagent-错题本.md](docs/ppagent-错题本.md) (entry numbers below); consult it before touching these areas.

- Messages are a discriminated union with `assertNever` exhaustiveness checks, not a class hierarchy (1.1).
- `Context.systemPrompt` is its own field, never a `Message` subtype (1.2).
- Subprocess spawns from the bash tool MUST pass `detached: true` and kill the whole process group on cancel, or grandchildren get adopted by init and leak (1.6).
- Compaction is override-style, not chained; summaries must accumulate the previous summary, never nest it by concatenation (5.3).
- `core` exposes only `ReadonlyContext` outward; internal mutable `Context` never leaks through a getter (5.4).
- A stub must implement the full interface (never `throw new Error('not implemented')`) and its return value must be configurable, so callers can exercise both branches before the real implementation lands (design doc §7).
- Failures degrade rather than throw — a flaky local inference server or a malformed stream should degrade quality, not abort the task. Only user-initiated cancellation propagates as a real abort (5.3).

## Out of scope

Do not add these — they are deliberate non-goals (design doc §9), not gaps:

- A multi-provider abstraction layer. The only wire target is OpenAI-compatible `/chat/completions`.
- Prompted/simulated tool calling as a fallback for models without native tool-calling support.
- Plan mode or complex subagent orchestration — every added capability grows the system prompt, which this project treats as a scarce resource for local models.

## Agent Notes

Any non-trivial change (behavior, architecture, cross-file convention, on-disk/wire format) adds or updates a decision record in `docs/notes/` in the same change — see [docs/notes/README.md](docs/notes/README.md) for format and how it differs from the 错题本. `## Alternatives considered` is mandatory: undocumented alternatives get re-litigated.

## Editing these instructions

`CLAUDE.md` is a symlink to this file — edit `AGENTS.md`, not the symlink. Keep this file under 140 lines (enforced by `test/guards.test.ts`); it is injected into every session's system prompt, so treat length as a real cost, not paperwork. If a genuinely necessary addition would exceed the limit, cut something else first.
