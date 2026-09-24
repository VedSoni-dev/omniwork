# Engine overhead and coding benchmark results

This report records the engine optimization experiment on OpenCode 1.18.31. Host-specific temporary workspace prefixes in the published JSON are replaced with `<benchmark-workspace>`.

## Decision

Keep `standard` as the worker default. Offer `scoped` for explicitly bounded local coding workloads, and retain `focused` as an experimental compact-prompt profile. Reducing the first request is useful, but cannot by itself establish coding quality or end-to-end efficiency. The small sample and task-level regressions do not justify changing every user's workflow.

Scoped retains the upstream model-specific coding prompt and repository instructions, while omitting the automatic skills catalog and unrelated tools. Both restricted profiles retain read/search/edit/shell tools and use a 24-step conversation cap. The profile uses OpenCode's supported agent configuration; it does not modify provider identity or user configuration files.

Batch clients can opt in with `defaults: { "engine_profile": "scoped" }` in `jobs_submit`. Individual task overrides remain available. See [worker profiles](../../../docs/worker-service.md#opencode-worker-profiles).

## Direct request measurement

The real installed OpenCode 1.18.31 engine sent identical requests to a local synthetic inference endpoint. The fixture included repository instructions and 20 unrelated skills; the local global skill configuration also contributes to the baseline. No paid or real inference was used by this probe.

| Profile | Serialized messages + tool schemas | Reduction |
| --- | ---: | ---: |
| Standard | 86,634 characters | — |
| Scoped | 27,136 characters | 68.7% |
| Focused | 19,366 characters | 77.6% |

All three retained the repository instruction marker. Both restricted profiles omitted the fixture skills and recursive/unrelated tools. These are character counts in this environment, not token counts or a universal savings percentage. [Raw request measurements](request-measurement.json).

## Live coding comparison

The completed paired run uses six controlled regressions in actual OmniWork modules, one attempt per profile per task, the same free Big Pickle model, a five-minute deadline, and a 600,000 observed input/output token budget per job. Acceptance requires withheld checks, successful application through the worker service, and a second withheld check on the integrated source. A passing public smoke test alone does not count.

| Metric | Standard | Scoped |
| --- | ---: | ---: |
| Accepted fixes | 3/6 | 4/6 |
| Total observed input | 2,814,238 | 1,924,518 |
| Uncached input | 213,534 | 117,926 |
| Cache-read input | 2,600,704 | 1,806,592 |
| Output, including reasoning | 103,474 | 80,217 |
| Observed model requests | 65 | 73 |
| Input per accepted fix, failures included | 938,079 | 481,130 |
| Median job execution | 143.7 s | 124.8 s |

Scoped reduced total input by **31.6%**, uncached input by **44.8%**, and input per accepted fix by **48.7%** in this run. Median execution was 13.2% lower, but observed model requests increased from 65 to 73. This is a result for this workload, not a guaranteed speedup. All 12 jobs returned usage; four budget-limited jobs may have additional unobserved in-flight usage.

| Task | Standard: accepted / input / requests | Scoped: accepted / input / requests |
| --- | --- | --- |
| output-paging | Yes / 222,051 / 8 | Yes / 144,335 / 9 |
| catalog-policy | Yes / 277,041 / 10 | Yes / 105,107 / 6 |
| compaction-continuity | Yes / 465,039 / 11 | Yes / 540,320 / 21 |
| repair-accounting | No / 609,291 / 12 | No / 181,770 / 8 |
| workspace-boundaries | No / 591,190 / 13 | Yes / 360,419 / 15 |
| durable-admission | No / 649,626 / 11 | No / 592,567 / 14 |

Both profiles changed the repair-history semantics and failed the withheld history-length check; standard also exhausted its observed token budget. Standard workspace-boundary work and both durable-admission jobs exhausted their budgets before successful completion. The standard workspace patch and scoped admission patch passed withheld tests, but their jobs did not meet the full completion-and-integration acceptance rule. Standard admission also failed withheld evaluation. Scoped compaction used 21 requests versus 11, consumed more total input, and took 177.3 seconds versus 127.8 seconds despite its smaller initial request.

The service admitted all 12 tasks in 41 ms; that excludes service startup and task execution. The full paired run took 13 minutes 11 seconds with at most two jobs active for the provider. The runner exited nonzero because five jobs were unaccepted, while the report correctly records `complete: true` and no unfinished jobs. This is a completed experiment with model failures, not a crashed benchmark.

[Raw paired results](scoped-comparison.json) and [individual patches](scoped-comparison.json.patches/) preserve the evidence. Budget exhaustion is recorded as a failed job; neither a plausible answer nor a passing patch alone is counted as an accepted result.

## What changed

- Added explicit standard/scoped/focused selection in durable task contracts and OpenCode requests. Permissions restrict the tool catalog at both agent and session level so broad session rules cannot silently restore it.
- Separated uncached input, cache reads/writes, reasoning and observed model requests. Repeated events are deduplicated and repair usage accumulates.
- Added six regression families: output paging, catalog policy, compaction continuity, repair accounting, workspace boundaries, and durable admission. Every reference passes; every seeded regression fails. Preflight runs the exact public command workers receive.
- Added atomic benchmark reports, interrupted-run checkpoints, read-only transport retries, retained workspaces on interruption, and resume without duplicated admission or blind patch replay.
- Included failed work in tokens per accepted fix and exposed missing usage separately. Service configuration fingerprints now include engine configuration, preventing incompatible daemon reuse.

## Validation

All 15 regression suites pass. The additional synthetic-inference recovery test interrupts the actual benchmark runner/daemon, resumes the original IDs, retains failures, and checks cleanup only after completion. No live model is needed for the deterministic suite. Syntax and whitespace checks pass.

## Interpretation and remaining work

The fixtures are controlled regressions chosen by the implementer, not organic issue samples or SWE-bench results. One model and one repetition cannot establish statistical significance or general coding superiority. The profiles differ in tool availability, catalog content, and step cap; this experiment does not isolate those effects separately.

Observed total input includes cache reads/writes and repeated history across requests. It is not unique context size, billable input, or additional provider entitlement. Partial jobs can have unobserved in-flight usage. Engine child/background sessions are not a complete billing ledger. Provider quotas still apply.

Earlier compact-prompt trials and interrupted comparisons were excluded from this completed paired comparison. The original pilot had a public-command path bug and is explicitly marked invalid. The old three-task smoke comparison used different runs and cannot establish a controlled speedup.

The next quality gate is pinned historical issues from independent repositories, multiple models and repeated trials, with fixed held-out tests and existing-test preservation. Request-count growth, repeated source reads, and long tool outputs should be measured per task before further prompt removal. Do not remove model-specific guidance based solely on a smaller first request.

## Research references

- [OpenCode custom agents](https://opencode.ai/docs/agents/): supported prompt, permissions, and step configuration.
- [Pinned request construction, v1.18.31](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/llm/request.ts), [system prompt construction](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/system.ts), and [tool resolution](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/tools.ts): reviewed to identify where agent prompts, skill catalogs, and merged permissions affect input.
- [SWE-bench evaluation](https://www.swebench.com/SWE-bench/guides/evaluation/) and [Aider benchmarks](https://aider.chat/docs/benchmarks.html): references for patch-and-test evaluation. This local corpus does not reproduce either benchmark.

Reproduction commands and evaluator limitations are in [coding benchmarks](../../../docs/coding-benchmarks.md).
