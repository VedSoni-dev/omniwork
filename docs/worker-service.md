# Durable coding workers

The `jobs_*` MCP tools and `omniwork-jobs` CLI share one background Node service per OmniWork data directory. Submit a batch, retain the returned IDs, and disconnect if needed. The service owns execution and stores results independently of the submitting client. It reuses the gateway and OpenCode engine across jobs.

These are ordinary MCP tools. They do not claim support for the optional MCP Tasks protocol extension.

## Start a batch

From an installed source checkout, register `node /absolute/path/to/omniwork/electron/mcp-server.js` with your MCP client. For Codex:

```sh
codex mcp add omniwork -- node /absolute/path/to/omniwork/electron/mcp-server.js
```

Claude Code's interactive setup is `npm run connect`. It previews and requests permission for its global configuration edits. Installing this implementation does not itself modify those configurations.

Call `jobs_submit` with:

```json
{
  "cwd": "/absolute/path/to/project",
  "request_id": "parser-fix-v1",
  "defaults": {
    "policy": "free_only",
    "timeout_ms": 180000,
    "repair_attempts": 1
  },
  "tasks": [
    {
      "task": "Make the parser reject incomplete quoted strings. Preserve the existing API.",
      "allowed_paths": ["src/parser.js"],
      "context_files": ["src/parser.js", "test/parser.test.js"],
      "checks": ["node --test test/parser.test.js"]
    },
    {
      "task": "Document the current configuration options with examples.",
      "allowed_paths": ["docs/configuration.md"],
      "context_files": ["src/config.js"],
      "checks": ["npm run lint:docs"]
    }
  ]
}
```

Use checks that exist in your project. Tasks may override defaults and `cwd`. Exact files or directory prefixes ending in `/` specify ownership; an empty list imposes no path constraint. Stable `request_id` values make retries idempotent. Reusing a key with a changed task contract or batch size is rejected. Each admitted job is saved before becoming executable; a partially persisted batch can be retried with the same key.

The CLI accepts the same JSON as `npm run jobs -- submit tasks.json`, or a single task object with its own `cwd`. It also accepts standard input via `submit -`.

## Retrieve and integrate

| Tool | Purpose |
| --- | --- |
| `jobs_submit` | Persist 1–100 task contracts and return IDs immediately. |
| `jobs_wait` | Wait up to 25 seconds for a terminal result, or a change after `after_revision`. |
| `jobs_get` | Compact evidence; `detail: true` includes the contract, attempts, and acceptance output. |
| `jobs_list` | Recover recent IDs; filter by status and paginate. |
| `jobs_read` | Read a character page from `patch`, `result`, or `trace`; continue at `next_offset`. |
| `jobs_cancel` | Stop queued or active work while retaining evidence and workspaces. |
| `jobs_apply` | Validate and apply a completed isolated patch to the original source. |
| `jobs_status` | Inspect shared capacity, provider cooldowns, and counts. |

CLI commands are `submit`, `get`, `wait`, `list`, `cancel`, `apply`, `status`, `refresh`, and `stop`. `wait` accepts comma-separated IDs. One wait does not guarantee the entire batch has finished; inspect each returned status and wait again for unfinished jobs. MCP callers should pass the last revision cursor when waiting for further changes.

Statuses include `queued`, `blocked`, `preparing`, `running`, `collecting`, `cancelling`, and terminal `completed`, `partial`, `failed`, `cancelled`, or `interrupted`. A job without acceptance commands can complete with `verification: unverified`; it cannot be applied through `jobs_apply`.

Default isolation snapshots tracked files and nonignored untracked files, including current dirty edits, using a temporary Git index and a detached worktree. The source index and branch are preserved. Git and an existing HEAD commit are required. Ignored dependencies and secrets are not copied. Optional `setup` commands install dependencies in the worktree and run again in the integration worktree. `isolation: shared` instead runs directly in the supplied directory and cannot offer patch isolation.

A failed acceptance check can trigger a bounded repair in the same worker conversation. The repair receives check evidence and shares the original job deadline and token budget. Artifacts include binary patches and new files. Changes outside ownership block application.

Application is serialized across clients. It rejects overlapping source changes, constructs a fresh integration snapshot including other current edits, applies the patch there, and reruns setup and acceptance commands. It refuses checks that alter patch files and refuses a source snapshot that changes during validation. Only then does it apply to the original working directory. Reapplying a recorded application is idempotent. This is a local Git workflow, not a filesystem transaction against unrelated external processes.

## Capacity and model policy

Defaults are four active jobs and two per provider. Provider selection considers available slots, observed failures, and latency. This is operational routing, not a learned measure of coding ability. Native inference requests are paced at 20 requests per minute per provider; provider cooldowns are shared across clients. A native provider outage before any tool call may retry twice within the original deadline. Engine execution and work with tool side effects are not automatically replayed.

Omitting `model` selects a connected tool-capable model marked free by the catalog. `free_only` blocks paid or unknown-cost entries. `allow_paid` requires a concrete model ID; there is no automatic paid fallback. Search with `list_models`, connect accounts through the provider tools or `npm run providers -- login`, then submit or refresh the queue. Free classification reflects provider/catalog metadata and is not a billing guarantee or quota exemption.

| Setting | Default | Scope |
| --- | --- | --- |
| `OMNIWORK_JOB_CONCURRENCY` | `4` | Active jobs, maximum 32. |
| `OMNIWORK_JOB_PROVIDER_CONCURRENCY` | `2` | Active jobs per provider, maximum 32. |
| `OMNIWORK_JOB_RPM` | `20` | Native requests per minute, and engine conversation admission pacing. |
| `OMNIWORK_JOB_PROVIDER_LIMITS` | `{}` | JSON keyed by provider, each entry containing integer `concurrency` and `rpm`. |
| `OMNIWORK_DATA_DIR` | OS app data | Separate service and artifact location. |

For example, `OMNIWORK_JOB_PROVIDER_LIMITS='{"local":{"concurrency":4,"rpm":120}}'` overrides a provider identified as `local`. Consult `jobs_status` for actual provider keys. Configure environment variables on the MCP process that first starts the service. Stop and restart the service to change scheduling settings. Different gateway credentials or engine configuration cannot silently reuse an incompatible running service.

Per-job defaults: 180 seconds, 200,000 observed input/output tokens, 24 native steps per conversation turn, and one repair. Limits are 30 minutes, 2,000,000 tokens, 80 steps, and three repairs. A request in flight can exceed the observed token limit. OpenCode controls its internal requests and tools; OmniWork can pace conversation starts and limit active jobs, deadlines, and observed usage. Scoped and focused engine workers have their own fixed 24-step cap; the per-job `max_steps` setting still controls the native loop only. Usage from failed native provider attempts reduces the remaining retry budget and is retained in `providerHistory`; final result usage describes the execution attempt, including its repairs.

## OpenCode worker profiles

Durable jobs default to `engine_profile: "standard"`. Profiles are explicit because lower input overhead does not guarantee better coding outcomes.

| Profile | Coding instructions | Available tools |
| --- | --- | --- |
| `standard` (default) | Upstream model-specific prompt and project rules | Full OpenCode agent, including skills and connected tools. |
| `scoped` | Upstream model-specific prompt and project rules | Local read/search/edit/shell tools; automatic skills catalog and unrelated tools omitted. |
| `focused` (experimental) | Compact custom prompt and project rules | Same local tool selection as scoped. |

For independent local coding jobs, try `defaults: { "engine_profile": "scoped" }` in `jobs_submit`; override individual tasks when they need skills, web access, connected MCP tools, or recursive delegation. Scoped/focused use supported OpenCode custom agents with a 24-step conversation limit. Their configuration is passed to the child engine through its environment; user OpenCode configuration files are not rewritten. See [coding benchmarks](coding-benchmarks.md) for reproduction and quality limits.

Desktop sessions and legacy delegations keep their existing default agent. Permissions still follow the selected approval mode; tool selection is not an operating-system sandbox. Existing running daemons must be stopped/restarted to load updated engine code. Explicit profiles in already admitted jobs are retained.

Engine usage now reports `uncachedInTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, and `modelRequests` alongside existing totals. `inTokens` includes uncached input plus cache reads/writes; `outTokens` includes output plus reasoning. Repeated usage events are deduplicated by message, and repair turns accumulate usage. These measure the observed session; independently running engine background/child sessions are not a complete account billing ledger. Missing detailed fields mean unavailable, not zero.

## Request traces and verification reserves

Durable jobs save a bounded `trace.json`, retrievable with `jobs_read(id, artifact: "trace")`. Compact status includes the trace summary and queue/preparation/execution/collection timings. Benchmark runs preserve traces in a companion `.traces/` directory before deleting temporary workspaces.

The trace merges engine assistant-message updates by ID and records observed per-request usage, timestamps, tool names, tool durations, output byte counts, and repeated read/search argument fingerprints. Fingerprints use a per-execution secret; saved traces contain no prompts, source text, tool arguments, tool outputs, or raw errors. Existing result/patch artifacts still contain their normal task evidence. Each request/tool table is capped at 1,000 entries, with discarded events counted.

Timing is observational: assistant-message lifetimes can include tool execution; cumulative durations overlap and are not pure inference time. Missing timestamps remain unknown. Requests initialized with zero tokens are not marked usage-reported without a completed-step receipt or nonzero usage. Interrupted requests can therefore have unknown final usage. Native workers currently provide tool traces only, with request coverage marked unavailable; engine background/child work and internal provider retries are not fully captured. Traces become durable when execution returns, not after every event. Repeated argument fingerprints identify candidates for inspection, not proof that a read was unnecessary after edits.

To reserve room for verification on an isolated, pinned OpenCode worker:

```json
{
  "model": "opencode/big-pickle",
  "engine_profile": "scoped",
  "max_tokens": 200000,
  "timeout_ms": 180000,
  "verification_reserve_tokens": 40000,
  "verification_reserve_ms": 30000,
  "checks": ["npm test"]
}
```

Restart an older worker service with `npm run jobs -- stop` before using these capabilities; the client refuses to reuse a daemon from the previous capability version.

Both reserve settings default to zero. They require `scoped` or `focused`, worktree isolation, and caller acceptance checks. At the first soft threshold in the initial model turn, OmniWork requests an engine abort, waits for the prompt response, and requires an acknowledged stop plus idle status. Only then does it run the checks. Passing checks can finish the job without an additional model-authored summary. Failed checks can trigger the existing bounded repair in the same agent/workspace; repairs use the remaining original budget and receive no second soft checkpoint.

The hard token cap, original deadline, caller cancellation, ownership checks, and integration checks still apply. A request can overshoot the soft and hard token thresholds. Stop-confirmation failure or a provider error cannot be converted into success. Engine startup, tool shutdown, and check duration may exhaust the reserved time; these settings do not guarantee completion. Arbitrary detached processes are outside this coordination guarantee. Use strong acceptance commands; a passing smoke test cannot establish requirements it does not test.

Run `node scripts/probe-engine-checkpoint.js` to exercise the installed engine against synthetic local inference. It writes a fixture, stalls a subsequent model response, and asserts stop/idle before verification. This probe spends no real inference tokens and does not measure coding-quality gains.

## Context and practical boundaries

Workers receive a bounded task contract, selected file excerpts, and a cached repository orientation map of relevant paths and declarations. The map is capped at 4,000 characters; explicit file excerpts total at most 24,000 characters. Full content remains accessible through tools. Parent clients receive compact evidence and can retrieve artifacts without absorbing every worker transcript.

The service benefits `jobs_*` calls. Legacy `delegate`, `delegate_parallel`, ACP turns, and desktop sessions run outside its scheduler. OpenCode's own internal tool execution or subagents are not individually scheduled by this service.

Worktrees isolate ordinary edits; they are not operating-system sandboxes. Worker commands and acceptance commands run with the user's privileges. Keep acceptance tests outside worker-owned paths and review meaningful changes. Passing the supplied commands establishes only what those commands test.

There is no dependency graph, automatic cross-job conflict resolution, durable provider conversation resumption after a daemon crash, or automatic workspace garbage collection yet. Parallel tasks should have independent ownership. Retained worktrees and artifacts use disk space. On restart, uncertain in-flight execution is marked interrupted instead of silently replayed; inspect it before resubmission. An interrupted integration may require inspecting both source and the retained integration directory. The service exits after 15 idle minutes without queued or active jobs, and the next client restarts it. Completed results remain on disk.

Artifacts live beneath `<data-dir>/jobs/tasks/<id>/`; `job.json`, `result.json`, `trace.json`, `changes.patch`, and the worktree provide evidence. The service descriptor contains a private token for its loopback API; do not share it. `service.log` records service errors. To clean a retained Git worktree, stop relevant jobs, inspect the output, and use `git worktree remove <path>` before deleting its artifact directory.

## Validation and design references

`npm run test:regression` includes deterministic service tests and a real multi-client MCP/daemon fixture. `node scripts/benchmark-jobs.js --live` runs three small coding fixtures using a connected free model, then integrates and retests their patches. This is opt-in because it sends real inference requests. For paired repository regression tasks and a local request-size probe, see [coding benchmarks](coding-benchmarks.md).

The design borrows bounded repository orientation from [Aider's repository map](https://aider.chat/docs/repomap.html), using a simpler deterministic path/declaration index here. Reconnectable work follows the durable-handle motivation in [MCP Tasks](https://modelcontextprotocol.io/extensions/tasks/overview), while retaining ordinary tool compatibility. Neither inspiration establishes equivalent implementation or benchmark performance.
