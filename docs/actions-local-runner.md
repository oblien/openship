# Openship Actions — a local GitHub Actions runner

**Status:** proposed · **Owner:** TBD · **Target module:** `apps/api/src/modules/actions`

Run a repo's own `.github/workflows/*.yml` **entirely on the user's own server**, discovered
during the deploy wizard, rendered as a job graph in a dedicated **Actions** tab, and mirrored
back to GitHub as **Check Runs** so the PR/commit UI shows status exactly as if GitHub had
run it.

No new config format. The workflow file GitHub reads is the workflow file we read.

---

## 1. Scope decisions (settled)

| Question | Decision | Why |
|---|---|---|
| Config format | `.github/workflows/*.yml` verbatim | "Same files GitHub uses" is the whole point. A repo stays portable; a user can move off us. |
| Per-project overrides | **DB rows, never a repo file** | An `.openship/actions.json` would fork the source of truth and force Openship-specific commits. Enable/disable, runner-image mapping and secret bindings live in `action_workflow` / project settings. |
| Home in the UI | **Its own project-level `Actions` tab** | Not the Jobs tab. See §2. |
| Execution substrate | **Container substrate** (`DockerRuntime` + `docker-exec-stream`) | Not the jobs SSH executor. See §2. |
| Step isolation | **One container per job, one `docker exec` per step** | Steps must share a filesystem, `$GITHUB_PATH` and installed packages. Container-per-step breaks `apt-get install` persistence. This is the model `act` uses. |
| v1 hosting mode | **Self-hosted only** | Cloud needs a metered, isolated runner pool + a docker-in-docker answer (§7). Gate behind `PLATFORM_FEATURES`. |

---

## 2. Why this is NOT the Jobs module

The jobs module is a good *definition-level* DAG scheduler, and it is the wrong runtime.

| | `jobs` | Actions needs |
|---|---|---|
| Node body | one shell command string (`CommandConfig.command`) | ordered steps, each with its own env/shell/`if`/timeout |
| DAG shape | DAG of **definitions**, edges resolved across all-time run state (`assertDependencyGraphOk`, `job.service.ts:273`) | DAG **per run**, pinned at plan time, matrix-expanded |
| Executor | `sshManager.withExecutor → streamExec` | container exec |
| Timeout | **best-effort, "can't kill the remote process"** (`job-command.ts:11`) | must actually cancel — `cancel-in-progress`, the Cancel button, `check_run` cancellation |
| Filesystem | none | a checked-out workspace shared across steps |
| Run states | `running / success / failed` | `queued/in_progress/completed` × `success/failure/cancelled/skipped/neutral/timed_out/action_required` |

Modelling workflow jobs as `job` rows would mean widening `CommandConfig`, adding a second
DAG semantics to `assertDependencyGraphOk`, and adding container execution to an SSH executor.
Separate tables, separate runner.

**What we do reuse from jobs:** the cron registry (for `on: schedule`) and the notification
dispatcher. That's it.

---

## 3. Reuse map

The load-bearing point of this plan: most of the hard, already-debugged machinery exists.

### Execution
| Reuse | Path | What it gives us |
|---|---|---|
| `buildInContainerExecCmd(cmd, timeoutMs)` | `packages/adapters/src/runtime/docker.ts:318` | A step exec that **actually kills its process tree** on timeout (setsid + negative pgid). This is the single hardest bit of a step runner and it is done. |
| `resolveExecExitCode(exec)` | `docker.ts:348` | Refuses to guess an exit code during dockerode's `Running:true/ExitCode:null` window. Prevents "failed step reported green". |
| `splitDockerFrames` / `docker-demux.ts` | `docker.ts:731` | stdout/stderr demux for step logs. |
| `docker-exec-stream.ts` | `packages/adapters/src/runtime/` | Bun-safe raw hijack. dockerode's own hijack **hangs forever under Bun** — already solved here. |
| `DockerRuntime`, `docker-transport.ts` | `runtime/docker.ts:920` | container create/start/stop/rm against unix socket, TCP (SSH bridge) or TLS — i.e. runs on any target server. |
| `buildNetworkAliases` | `docker.ts:376` | east-west DNS for `services:` containers. |
| `toDockerHealthcheck` | `docker.ts:629` | `services.*.options --health-cmd`. |
| `resource-limits.ts` | `runtime/` | per-job cpu/mem caps. |
| `git-clone.ts`, `clone-auth.ts`, `github-known-hosts.ts` | `runtime/`, `modules/github/` | `actions/checkout` — auth, known-hosts and App-installation tokens already solved. |
| `packages/adapters/src/toolchain` | — | `actions/setup-node|python|go` shims. |

### GitHub wiring
| Reuse | Path | Notes |
|---|---|---|
| `createCheckRun` / `updateCheckRun` | `modules/github/github.service.ts:765,828` | Already pins `credential: ["app-installation"]` — the Checks API is App-only and an unpinned chain 403s silently. **Do not un-pin.** |
| `deployment_check_run` table shape | `packages/db/src/schema/deployment-check-run.ts` | Copy the rollup + per-item two-flavor pattern, including the **partial** unique indexes (a plain unique lets duplicate rollups coexist because PG treats NULLs as distinct). |
| `service-checks.ts` | `modules/deployments/` | The best-effort, never-blocks emitter pattern — and its recorded lesson: *never open an `in_progress` check without a guaranteed finalizer*, or it sits unresolved on the PR forever. |
| `webhook-check-run.ts` | `modules/github/` | `check_run.rerequested` is **already handled** for deploys. Extend it: lookup by `action_job.checkRunId` → re-run that job. |
| `webhook-push.ts`, `webhook-changed-files.ts` | `modules/github/` | Push trigger + **already computes changed files** — exactly what `paths:`/`paths-ignore:` filters need. |
| `github.token.ts`, `github-access.ts` | `modules/github/` | Minting the workflow's `GITHUB_TOKEN`. |
| `git/trees/:ref?recursive=1` | `github.service.ts:600` | Discovering `.github/workflows/*`. |

### Platform
| Reuse | Path | Notes |
|---|---|---|
| `resolveProjectInfo` + `projectInfoToScanResponse` | `modules/deployments/prepare.service.ts`, `github.controller.ts:827` | The wizard-detection seam. Add `workflows[]` here and the panel gets it for free on github / local-folder / upload sources alike. |
| `yaml` v2 | `apps/api/package.json:38` | Already a dependency. Anchors/aliases and good error positions. |
| `compose-parser.ts` | `apps/api/src/lib/` (1011 LOC) | The architectural template: hand-rolled normalize into a narrow typed shape, long tail parked in an `advanced` JSONB, errors surfaced to the wizard. |
| `boundedStorableText`, `build-log-sanitize.ts` | `modules/deployments/` | Log capping + secret masking (also backs `::add-mask::`). |
| `encryptEnvMap` / `decryptEnvMap` | `lib/encryption.ts` | Secrets at rest, decrypt at run time. |
| Backup destination abstraction | `modules/backup-destinations/` | S3-compatible object store → artifacts + cache. |
| `backup-stale-sweep.ts` | `modules/backups/` | Template for the orphaned-check-run / stranded-run sweeper. |
| Build-minute metering | migration `0107_build_minute_metering_indexes.sql` | Actions minutes metering already has a home. |
| Deployment SSE hook + `SSE_PRIMER` | dashboard + api | Live logs. nginx strips `X-Accel-Buffering` downstream — the primer prefix is mandatory. |
| `PLATFORM_FEATURES` / `useFeature` | — | Feature gate. |

### Must be BUILT (the actual new surface)
1. Workflow YAML parser + validator (`workflow-parser.ts`).
2. `${{ }}` expression engine (§5).
3. Run planner: matrix expansion, `needs` topo-sort, `if:` evaluation, concurrency groups.
4. Step runner + the runner file contract (`$GITHUB_OUTPUT/ENV/PATH/STEP_SUMMARY`) and `::` workflow-command parsing.
5. `uses:` resolution (§6) — the cost center.
6. Artifact + cache services.
7. Actions tab, run-detail DAG view, wizard panel.

---

## 4. Flow, end to end

```
push / PR / dispatch / schedule
  → trigger match (branches, tags, paths — via webhook-changed-files)
  → action_run row (event, headSha, actor, inputs)
  → PLAN: parse YAML → eval job-level if: → expand matrix → topo-sort needs
         → snapshot the resolved DAG into action_run.plan (jsonb)   ← pinned; a mid-run
                                                                      repo change cannot
                                                                      rewrite history
  → create rollup check run  openship/actions/<workflow>            (in_progress)
  → per ready job (respecting needs + max-parallel):
       create per-job check run  openship/actions/<workflow>/<job (matrix)>
       create workspace volume + job network
       start job container (runs-on → image), detached, sleep infinity
       per step:
         eval step if: → render ${{ }} → inject env
         docker exec  buildInContainerExecCmd(script, timeoutMs)
         stream frames → action_step.logs + SSE  (masked, bounded)
         resolveExecExitCode → status
         cat back $GITHUB_OUTPUT/$GITHUB_ENV/$GITHUB_PATH → step outputs / job env
         parse :: commands → annotations, masks, groups
       job outputs → needs.<job>.outputs
       complete per-job check run (+ annotations, + STEP_SUMMARY as output.summary)
       teardown container; volume kept per cache policy
  → complete rollup check run (aggregate conclusion)
```

`concurrency` + `cancel-in-progress`: cancel the prior run in the group, set its checks to
`cancelled`. Cancellation is real because the exec watchdog kills the process group.

---

## 5. Expression engine

New: `apps/api/src/modules/actions/expr/` — tokenizer, Pratt parser, evaluator. Pure, no I/O.

- **Contexts:** `github`, `env`, `vars`, `job`, `jobs`, `steps`, `runner`, `secrets`, `strategy`, `matrix`, `needs`, `inputs`.
- **Operators:** `!`, `<`, `<=`, `>`, `>=`, `==`, `!=`, `&&`, `||`, `.`, `[]`, and `*` object-filter globs.
- **Functions:** `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `hashFiles`, `success()`, `failure()`, `cancelled()`, `always()`.
- **The trap:** GitHub's loose equality coerces (`null == '' == 0 == false`), and
  `success()`/`failure()`/`always()` depend on *step-so-far* vs *job* state differently at
  step level and job level. This is where silent wrongness lives → exhaustive **table tests**,
  not example tests.
- `hashFiles` globs the workspace, so it runs as a container exec, not in-process.

Estimate ~900–1300 LOC + a large fixture table. Bounded and testable — this is not the risk.

---

## 6. `uses:` — the cost center, phased

**Tier 1 — native shims** (needed anyway, and better than GitHub's because our auth is solved):
`actions/checkout` (→ `git-clone.ts`), `actions/cache` (→ destination store),
`actions/upload-artifact` / `download-artifact`, `actions/setup-*` (→ `toolchain`).

**Tier 2 — generic JS actions:** resolve `owner/repo@ref` → tarball → extract to
`/opt/actions/...` in the workspace → read `action.yml` → `node /opt/actions/.../index.js`
with the toolkit contract (`INPUT_*`, `GITHUB_OUTPUT`, …), honouring `pre`/`post`.

**Tier 3 — docker actions** (`using: docker`): `docker run` image-or-Dockerfile with the
workspace mounted; args templated.

**Tier 4 — composite actions:** recursive step expansion.

**Refuse loudly (with an actionable message), don't fake:** `id-token`/OIDC, `environment:`
approvals, `workflow_call` (until Tier 4), `using: node16` (map to node20 + warn).

> ⚠️ **`actions/upload-artifact@v4` will not work against a hand-rolled endpoint.** v4 speaks a
> proprietary Twirp-style service, not the v3 REST shape. Either implement that protocol or ship
> the Tier-1 native shim and refuse v4-generic. This is the classic trap in every Actions clone.

---

## 7. Risks / killers — state these before committing

1. **The runner image is not clonable.** `ubuntu-latest` is a ~30 GB image with hundreds of
   preinstalled tools; real workflows silently assume `gh`, `jq`, `docker`, node and python
   exist. Mitigation: adopt the `catthehacker/ubuntu:act-*` images (built for exactly this),
   make `runs-on` → image a configurable map, and **surface the mismatch in the compat linter**
   rather than failing at minute 3 of a run.
2. **Docker-in-docker.** Many workflows `docker build`. Mounting the host socket into a job
   container is root-on-host. Acceptable-with-a-warning for single-tenant self-hosted;
   **disqualifying for cloud** without rootless/kata. This decision gates §1's "self-hosted only".
3. **`GITHUB_TOKEN` scope fidelity.** We can mint an installation token, but its permissions
   won't map 1:1 to `permissions:`. Scope-map and document; don't over-grant.
4. **`in_progress` checks that never complete** — the `service-checks.ts` lesson. Every run
   needs a stale sweeper.
5. **Compatibility is a treadmill, not a milestone.** Actions changes; marketplace actions
   assume runner internals. Budget ongoing maintenance, and never claim 100%.

---

## 8. Build vs. vendor — recommendation

Before Phase 2, run a **2-week spike against `nektos/act` (MIT, Go)**, invoked as a binary
inside a container, with its output parsed into our `action_job` / `action_step` model.

- If fidelity is good, it collapses Phases 2 + 5 (~10–15 wk of expression engine + action
  runtime) into ~3–4 wk of integration. We keep the parts that are ours anyway: discovery,
  tables, tab, DAG UI, Check Runs, triggers, secrets, artifacts.
- If not, we own the engine as specced above.

Either way the spike buys the one thing no amount of design produces: **which of our users'
actual workflows pass**. Run it over a corpus of real `.github/workflows` before committing to
Phase 5. Trade-offs of vendoring: a Go binary dependency, coarser per-step status granularity,
and inheriting act's own gaps (notably its artifact/cache servers).

---

## 9. Data model — migration `0109_actions.sql`

Follow the repo's JSONB-escape-hatch habit (`ComposeAdvanced`, `migration.inputSnapshot`) so v2
features don't each need a migration.

| Table | Key columns |
|---|---|
| `action_workflow` | projectId, path, name, yamlHash, parsed (jsonb), triggers (jsonb), compat (jsonb), enabled, lastSeenSha |
| `action_run` | workflowId, event, ref, headSha, actor, inputs (jsonb), **plan (jsonb — pinned DAG)**, concurrencyGroup, status, conclusion, checkRunId, startedAt, finishedAt |
| `action_job` | runId, jobKey, name, matrix (jsonb), needs (jsonb), serverId, containerId, checkRunId, outputs (jsonb), status, conclusion, startedAt, finishedAt |
| `action_step` | jobId, idx, name, uses, run, status, conclusion, exitCode, outputs (jsonb), logs (text, bounded), startedAt, finishedAt |
| `action_artifact` | runId, name, sizeBytes, destinationId, objectKey, expiresAt |
| `action_cache` | projectId, key, version, scopeRef, sizeBytes, objectKey, lastUsedAt |

Secrets: **reuse the existing encrypted credential store** (`encryptEnvMap`); add an
`action_secret` scoping table only if per-workflow scoping is required.

Retention: reuse the retention-prune pattern for logs, artifacts and caches from day one —
CI fills disks faster than anything else on the platform.

---

## 10. UI

**Wizard — "Detected workflows" panel.** After detection, per workflow: name, triggers, a mini
`needs` DAG preview, a compat badge (green / amber "N steps will be skipped" / red), and an
enable toggle. Detection returns the **parsed summary only, never raw YAML bytes** — `/detect`
is deliberately a metadata-tier route and must not become a repo-content side-channel.

**Actions tab (project level).** Runs list (workflow, event, branch, commit, actor, duration,
status pill via the status color tokens — never hardcoded emerald/red/amber).

**Run detail.** Left: the job DAG. Right: the selected job's steps as collapsible rows with live
logs.

> The dashboard has **no graph library** (no reactflow/xyflow/dagre/d3). Hand-roll the DAG as
> SVG with a layered left→right layout (longest-path layering by `needs` depth) — ~250 LOC and
> no new dependency. xyflow would be a heavy addition for one view.

Mandated primitives: `useModal` + `ui/Modal`, `CustomSelect` (never a native select), borderless
dotless pills, `bg-card` shell + solid `bg-muted` skeletons, and no bare destructive row icon
(cancel/delete belongs in the row `⋯` menu). Budget i18n across all locales.

---

## 11. Phases

| # | Scope | Effort | Value shipped |
|---|---|---|---|
| 0 | Discovery: tree scan, parser, compat linter, wizard panel, read-only Actions tab | 2–3 wk | "We see your CI" — real value with zero execution risk |
| 1 | Engine core: tables, planner, container/step runner, logs, SSE, cancel, run-detail DAG | 4–6 wk | `run:` steps actually execute locally |
| 2 | Expressions, matrix, `if:`, `needs` outputs | 2–3 wk | Real workflows stop erroring on syntax |
| 3 | Check Runs + triggers (push/PR/dispatch/schedule), `rerequested`, concurrency | 2–3 wk | **The headline: local execution, GitHub-native status** |
| 4 | Tier-1 `uses:` shims + artifacts + cache | 3–4 wk | checkout/setup/cache/artifacts — covers most real pipelines |
| 5 | Generic JS / docker / composite action runtime | 4–6 wk | Marketplace compatibility (the cliff) |
| 6 | Hardening: runner images, i18n, quotas, retention, docs | 2–3 wk | Shippable |

**Phases 0–3 ≈ 10–15 wk** → a genuinely useful local CI with GitHub-native status.
**All phases ≈ 19–28 engineer-weeks** → "runs most real workflows".
Insert the §8 act spike before Phase 2; it can remove ~10 wk.

### Is it hard?

Three different questions with three different price tags:

- **A pipeline engine with a node/DAG graph** — *not hard.* ~4–6 wk. We own the exec primitives,
  the DAG habit, SSE logs and the graph is 250 LOC of SVG.
- **Ingesting GitHub Actions YAML + GitHub-native Check Runs** — *moderate.* ~6–9 wk on top.
  This is the differentiated, high-value part, and it is mostly wiring existing pieces.
- **Being GitHub-Actions-*compatible*** (arbitrary marketplace actions running unmodified) —
  *hard, and unbounded.* Not hard-as-in-clever; hard-as-in-endless. This is where clones die,
  and it is the part to vendor (§8) rather than own.

The engine is not the risk. The ecosystem is.
