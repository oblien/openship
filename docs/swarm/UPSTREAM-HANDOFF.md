# Upstream review handoff

## Proposed PR description

### Problem

OpenShip previously treated Docker workloads as containers. A Swarm task is
disposable scheduler output, so using that model for stacks risks acting on the
wrong object and makes Portainer/CLI coexistence unsafe. Operators also lacked
a reviewed source, immutable revision, and recovery path for managed stacks.

### Architecture and scope

The change introduces an explicit `orchestratorMode: swarm` beside the existing
Docker/bare runtime choice. Docker remains the image build engine while a
manager-scoped stack adapter owns probe, discovery, rendering, apply,
convergence, source-backed revisions, service operations, and reconciliation.

Imported stacks start read-only in `observe` mode. A digest- and source-version
checked claim is required before OpenShip can write. Managed source builds push
digest-pinned images to an OCI registry; external routing remains the default,
and OpenShip Edge is a separate reversible cutover.

### Migrations

The series adds additive migrations for orchestration/runtime fields, Swarm
stack/revision/registry/source state, source versions, encrypted resource
inputs, storage acknowledgements, and volume replacement acknowledgements.
The PGlite persistence test applies the migration sequence forward and checks
stack/revision persistence. No migration drops or rewrites an existing
standalone Docker, bare, or cloud deployment.

### Security considerations

- Swarm manager Docker/SSH access is root-equivalent cluster-admin authority.
- Source path confinement, YAML limits, duplicate-key/tag/alias rejection, and
  rendered-document size bounds run before persistence or Docker mutation.
- Inline source, immutable rendered revisions, managed inputs, and registry
  credentials are encrypted. UI, logs, transfers, and audit views use redacted
  representations.
- Observe mode has no mutation authority; claim, release, and removal bind
  exact names plus current review tokens. Task containers never enter
  container-adoption, takeover, or lifecycle paths.

### Commands run

- `bun run test` — passed after the compatibility fixes: API 1,392 tests,
  adapters 666, DB 54, CLI 178, plus dashboard, desktop, and core.
- `bun run build`, `bun run --cwd apps/dashboard build`, and TypeScript lint
  checks for API, adapters, and CLI — passed.
- Swarm-specific manager, recovery, source, registry, operations, and large
  inventory proofs are recorded in [PROGRESS.md](PROGRESS.md) and executable
  commands are in [TEST-MATRIX.md](TEST-MATRIX.md).

### Demo steps

1. Set `OPENSHIP_EXPERIMENTAL_SWARM=true` on a disposable OpenShip instance.
2. Run `scripts/swarm-lab.sh up`, `deploy`, and `observe-proof` to demonstrate
   non-mutating manager observation.
3. Run `managed-proof`, `operations-proof`, `resource-proof`, and `edge-proof`
   only against that disposable fixture to demonstrate apply, reconciliation,
   operations, revision resources, and Edge topology.
4. Use the dashboard to view an observed stack, link reviewed source, render,
   claim, deploy, inspect logs, then release management back to observe mode.

### Screenshots/video

Capture these during reviewer acceptance rather than fabricating artifacts from
the test environment:

1. observed-stack dashboard with all write controls hidden;
2. redacted source/render preview and claim confirmation;
3. managed deployment convergence plus service/task log controls;
4. explicit Edge routing confirmation and release-management handoff.

### Known follow-ups

- Treat Portainer as a fallback/read-only console after claim; concurrent
  writers remain intentionally unsupported.
- The first release does not make node-local volumes portable or highly
  available.
- Add production pilot evidence only from an operator-approved cluster; the
  included Docker-in-Docker fixture is not production infrastructure.

## Review-unit map

The commits are deliberately contiguous and can be reviewed or split into the
following ten units without mixing their responsibilities. No PR has been
opened by this implementation task.

| Unit                                 | Commit range         | Review focus                                                                                                                |
| ------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1. Task safety / #311                | `97abc92d..c31b4d05` | Feature gate, disposable lab, and exclusion of task containers from container actions.                                      |
| 2. Read-only inventory               | `16c831fa..43ba99cc` | Manager probe, normalized discovery, health semantics, and authorized read APIs.                                            |
| 3. Schema and platform plumbing      | `2f4e11b4..bbfe3dd4` | Typed orchestration/runtime identity, additive persistence, and manager platform resolution.                                |
| 4. Source render and dry-run         | `f69703cd..ceb5fc6e` | Source confinement, rendering, redacted preview, compatibility preflight, observed import, and coexistence proof.           |
| 5. Prebuilt apply and reconciliation | `7fa02b8f..151a5053` | Immutable revisions, managed apply, explicit claim, convergence, and restart-safe reconciliation.                           |
| 6. Adoption and operations           | `5ecce2ff..3f5d1f05` | Scale/restart/log/remove, observed adoption, handoff, and release.                                                          |
| 7. Registry and build integration    | `2aff91df..98a58e96` | Encrypted registry credentials, digest publication, manager auth, and source-build records.                                 |
| 8. Routing and Edge                  | `67c15045..735906cd` | External routing preservation, explicit manager Edge topology, and reversible cutover.                                      |
| 9. Rollback and resources            | `cc91b616..745d099b` | Immutable rollback, config/secret versioning, managed inputs, storage risks, and identity preservation.                     |
| 10. UI, documentation, and hardening | `d816168b..d29b1cd9` | Project/deployment/rebinding UX, permissions/a11y, security, chaos, performance, compatibility, and operator documentation. |

Use [COMPATIBILITY-MATRIX.md](COMPATIBILITY-MATRIX.md) when reviewing any unit
that touches an existing runtime path.
