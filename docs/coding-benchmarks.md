# Coding efficiency benchmarks

Optimize verified useful work, not prompt size alone. A smaller request can lose its advantage if it causes more tool calls, failed checks, or repairs. The benchmark records those outcomes separately.

The [September 20 comparison](../benchmarks/results/2026-09-20/RESULTS.md) records the completed 12-job run, including failures and task-level regressions. Standard remains the default; scoped is selectable for bounded local coding.

## Controlled request inspection

```sh
npm run benchmark:engine-prompt -- --output reviews/request-size.json
```

This starts the installed OpenCode engine against a local synthetic OpenAI-compatible endpoint. It makes no real model inference calls. The temporary project includes a recognizable repository instruction and 20 unrelated fixture skills. Standard, focused, and scoped sessions receive the same request. Scoped keeps the upstream model-specific prompt; focused substitutes a compact custom prompt. The probe asserts that all three preserve the repository instruction, that restricted profiles remove the fixture skills catalog, and that recursive/unrelated tools are absent from restricted profiles.

The saved report contains message and tool-schema character counts and tool names, never full prompt text. Character counts measure serialized request size; they are not tokenizer measurements. Global configuration and installed skills can change the result, so the report describes the measured environment rather than a universal percentage.

## Repository regression comparison

```sh
# Offline: verify the task fixtures and evaluator first.
npm run benchmark:coding

# Real inference: free-only selection, two repetitions per profile.
npm run benchmark:coding -- --live --repeats 2 --profiles standard,scoped --model opencode/big-pickle \
  --output reviews/coding-comparison.json
```

This compares `standard` and `scoped` engine profiles by default; `--profiles standard,focused` evaluates the compact-prompt experiment. It runs six controlled regressions in actual OmniWork modules. Each task has two seeded faults and a behavior contract. The fixture copies the current `electron/*.js` tree so workers can inspect surrounding code. Each worker starts from its own mutated Git repository with no reference solution in its history.

| Task | Behavior under evaluation |
| --- | --- |
| Original output paging | Lossless retrieval, contiguous offsets, bounded previews, metadata and retention accounting. |
| Catalog policy | Free/paid/unknown classification, partial prices, explicit tool capability, combined filters. |
| Compaction continuity | Single-task tool cycles, repeated summaries, original constraints, summarizer failure, no orphaned tool results. |
| Repair accounting | Bounded same-worker repair, failed-check status, cumulative token/cache/request metrics. |
| Workspace boundaries | Traversal rejection, directory versus sibling ownership, private snapshots, source/index preservation. |
| Durable admission | Storage failure, idempotent retry, persistence before scheduling, shared provider identity. |

Preflight runs the evaluator on the reference implementation and requires success, then inserts the regression and requires failure. It also runs the **exact public command workers will run**, including its working directory and arguments. This catches harness mistakes before spending inference tokens.

The public smoke test is available to workers. Additional evaluator programs remain outside their checkouts and are not returned as repair feedback. After a terminal result, the harness runs those checks, applies successful patches through `jobs_apply`, and reruns withheld checks on the integrated source. Only that final success counts as accepted. Ownership excludes the public test and instructions. Worktrees are not adversarial isolation: withheld here means omitted from the worker checkout and prompt, not inaccessible to a malicious process with the user's privileges.

Task/profile ordering alternates between repetitions to reduce systematic order bias. A shared queue runs at most two jobs per provider, preserving a realistic concurrent workload. Each job gets 180 seconds by default (`--timeout-ms` can set the same deadline for both profiles), 600,000 observed tokens, and one repair. A full two-repetition run submits 24 jobs; provider quotas and real latency apply. The benchmark uses only the requested model if the catalog marks it free. It never silently falls back to a paid model.

## Read the report

The JSON records the source hash, engine version, model, preflight, per-task results, patches, verification, usage and elapsed time. Companion `.patches/` files make solutions inspectable. New runs also retain `.traces/` metadata with per-message usage, tool timing/output sizes, and repeated-read fingerprints. Timings include queue, preparation, execution and collection; engine message lifetimes are not pure inference time. Temporary service/worktrees are removed after complete runs. A transient read timeout is retried without replaying mutations. After an interruption or unrecoverable transport error, the service is stopped and an atomic checkpoint plus worktrees are retained. Resume with `node scripts/benchmark-coding.js --resume <report.json>`; existing job IDs are recovered, interrupted execution is not silently replayed, and an already recorded application is verified rather than applied again. Logical job failures remain scored failures. Use `--cases` with comma-separated task IDs for a smaller diagnostic run. The report has an explicit `complete` flag and unfinished IDs. The runner exits nonzero if any task is unaccepted or unfinished, but retains the report so failures remain part of the comparison.

The profile summaries include:

- Accepted jobs, total jobs, attempted jobs, and usage availability.
- Total input, uncached input, cache reads/writes, output and observed model requests.
- Repair count and median execution time.
- **Input per accepted task:** all input consumed by that profile, including failed jobs, divided by accepted jobs. It is undefined when none succeed.

`inTokens` is cumulative input across observed requests, including cache. It is not unique context size or a price estimate. Provider accounting of cached tokens against quota can differ. Missing usage and unobserved engine child/background sessions limit completeness. The detailed per-job records let you inspect such cases rather than infer that missing tokens were free.

This corpus is larger than the initial three tiny implementation fixtures, but it is still six controlled regressions chosen by the implementer. It does not establish general coding superiority, SWE-bench performance, or statistical significance. Two repetitions are useful for catching obvious variance; they are not enough for a broad ranking. Inspect per-task regressions instead of selecting a profile from aggregate tokens alone.

## Extend toward external coding quality

The next tier is pinned historical issue tasks from independent repositories, with clean environment setup, withheld regression tests, existing-test preservation, and explicit patch application. Keep initial tests and evaluation fixed before comparing profiles; include failures in the denominator and costs in the numerator. Run across multiple task families and models before widening defaults based on quality claims.

This follows the patch-and-test evaluation approach documented by [SWE-bench](https://www.swebench.com/SWE-bench/guides/evaluation/). Its official harness uses containerized repository environments; this local benchmark does not reproduce that isolation or dataset. [Aider's benchmarks](https://aider.chat/docs/benchmarks.html) provide another reference for evaluating coding rather than fluent answers.
