# Docker Swarm progress

Base commit: `50c04d6763f35f3654f8c765f2772e83d8b599a2` (`upstream/main`)

Branch: `feat/docker-swarm`

## S0.1: Pin the baseline, feature guardrails, and disposable test topology

Status: done
Commit: `7fe2af41`
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

## S0.2: Make container migration and Edge takeover Swarm-aware

Status: done
Commit: recorded in repository history
Tests run:

- `bun --cwd packages/adapters vitest run src/runtime/swarm/ownership.test.ts test/docker-container-status.test.ts src/system/proxy/detect.test.ts` — passed (30 tests).
- `bun --cwd apps/api vitest run test/modules/migration/docker-inspect.test.ts` — passed (9 tests).
- `bun run --cwd packages/adapters lint`, `bun run --cwd apps/api lint`, and
  `bunx tsc --noEmit -p apps/dashboard/tsconfig.json` — passed.
- `scripts/swarm-lab.sh up && scripts/swarm-lab.sh deploy && scripts/swarm-lab.sh compose-proxy && scripts/swarm-lab.sh status && scripts/swarm-lab.sh cleanup && scripts/swarm-lab.sh down` — passed. The nested manager ran a Swarm Traefik task on `*:80->80/tcp` and a separate ordinary Compose Traefik on `:18080`; cleanup removed only fixture resources.

Evidence:

- Docker task labels become a typed ownership discriminator on container
  summaries and inspections. Migration discovery reports them separately and
  prevents them entering the standalone adoption path before inspection or
  image reads.
- Edge port probing recognizes Swarm ingress ownership from the manager's
  service table, names the owning stack/service, and refuses the legacy
  container-level takeover with `SWARM_SERVICE_OWNED` before any executor
  command is issued.
- A read-only check against the local Docker daemon classified an existing
  Swarm task with live service and task IDs, without changing it.

Next:

- Publish the tracker and draft review slice (S0.3), then begin the durable
  orchestration domain model.
