# Docker Swarm progress

Base commit: `50c04d6763f35f3654f8c765f2772e83d8b599a2` (`upstream/main`)

Branch: `feat/docker-swarm`

## S0.1: Pin the baseline, feature guardrails, and disposable test topology

Status: done
Commit: pending
Tests run:

- `bun install --frozen-lockfile` — passed with Bun `1.3.3`.
- `bun run build` — passed.
- `bun run test` — pre-existing failure: dashboard i18n parity reports
  `deploy: 90 missing (baseline 18)`. Turbo cancelled the remaining API and
  adapter tasks after that failure, so their aggregate result is not evidence
  for this feature.
- `docker version --format '{{.Server.Version}}'` — `29.5.3`.
- `docker info --format '{{.Swarm.LocalNodeState}} {{.Swarm.ControlAvailable}}'`
  — `active true`.
- `scripts/swarm-lab.sh up && scripts/swarm-lab.sh deploy && scripts/swarm-lab.sh status`
  — passed; manager and worker converged the replicated, global, stateful, and
  externally routed fixture services.
- `scripts/swarm-lab.sh cleanup && scripts/swarm-lab.sh down` — passed; only
  test-namespaced resources were removed.
- `bun --cwd apps/api vitest run test/modules/health-env-authmode.test.ts` —
  passed (6 tests; test process reports an unrelated local Redis connection
  warning).
- `bun --cwd packages/adapters vitest run src/runtime/swarm/test-helpers.test.ts`
  — passed (2 tests).
- `bun run --cwd apps/api lint`, `bun run --cwd packages/adapters lint`, and
  `bunx tsc --noEmit -p apps/dashboard/tsconfig.json` — passed.

Evidence:

- `OPENSHIP_EXPERIMENTAL_SWARM` is centrally parsed, defaults off, and its
  resolved value is returned to the dashboard boot capability response.
- The disposable nested-Docker lab, read-only task helpers, and a
  namespace-scoped cleanup command are available under `fixtures/swarm/`,
  `packages/adapters/src/runtime/swarm/`, and `scripts/swarm-lab.sh`.

Blockers:

- The dashboard's existing locale-parity failure must remain distinguishable
  from Swarm regressions. It is outside this story's scope.

Next:

- Prevent container-level adoption and Edge takeover actions on Swarm task
  containers (S0.2).
