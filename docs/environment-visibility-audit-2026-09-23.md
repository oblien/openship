# Service environment visibility audit

Baseline: `v0.7.2` (`541ba903`) through main `d03378b6`.

## Reproduced failure

The reported API service had **35 saved Compose environment keys and zero
service override rows**. The old service editor read only `env_var` rows for that
service, so it showed “No environment variables.” The values remained in
`service.environment`; they had not been deleted. A read-only comparison with the
deployed Docker container confirmed all 35 effective values matched.

The Apply button checked only whether the service was enabled and had a deployment
or container. It did not establish whether any environment change was pending.
Both UI failures were reproduced with failing regression tests before the fix.

## History reviewed

The audit followed the editor's history and reviewed first-parent changes touching
environment storage, encryption, Compose merging, migration and service operations.
File moves into the shared platform engine were included.

| Change                                                                                                   | Environment behavior                                                                                                                                   | Finding for this report                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`238ceaaf`](https://github.com/oblien/openship/commit/238ceaaf), before v0.7.2                          | Separates Compose defaults from the service override editor.                                                                                           | The overrides-only read already exists here and in v0.7.2. Keeping ownership separate was right; presenting this subset as the entire environment was incomplete. |
| [#887](https://github.com/oblien/openship/pull/887)                                                      | Moves operations into the engine/SDK architecture; centralizes secret reveal.                                                                          | Retains the same overrides-only editor.                                                                                                                           |
| [#891](https://github.com/oblien/openship/pull/891)                                                      | Restores shared project editing, scopes project reads, encrypts service configuration and snapshots, shares Compose resolution.                        | Correct storage and scope fixes. They do not make Compose/shared values appear in the service editor.                                                             |
| [#892](https://github.com/oblien/openship/pull/892)                                                      | Recovers Compose interpolation provenance and adds legacy-value review.                                                                                | Addresses upstream refresh, not the editor's read model. The later automatic merge in #916 replaces the blocking review behavior.                                 |
| [#899](https://github.com/oblien/openship/pull/899)                                                      | Changes service/cloud quota and runtime behavior.                                                                                                      | No change to the environment editor's data source.                                                                                                                |
| [`6629a084`](https://github.com/oblien/openship/commit/6629a084)                                         | Adds environment Apply and download.                                                                                                                   | Introduces the unconditional Apply availability for deployed services. Reuses the incomplete editor.                                                              |
| [#905](https://github.com/oblien/openship/pull/905)                                                      | Saves reviewed migration environment in the encrypted service scope, preserving Compose templates.                                                     | Repairs newly migrated configurations. It cannot make existing Compose-only configurations visible through an overrides-only read.                                |
| [#908](https://github.com/oblien/openship/pull/908)                                                      | Reviews #905 and repairs duplicate imported routing endpoints.                                                                                         | Routing follow-up; no environment visibility change.                                                                                                              |
| [#916](https://github.com/oblien/openship/pull/916)                                                      | Preserves saved values through partial updates and Compose refresh, removes routine approval gates, fixes missing badges and failed Apply restoration. | These storage/runtime fixes remain valid. The service editor still ignores the Compose and shared layers.                                                         |
| [#912](https://github.com/oblien/openship/pull/912), [#923](https://github.com/oblien/openship/pull/923) | Reorganize service tabs, volumes and backups.                                                                                                          | Preserve the same incomplete environment read.                                                                                                                    |

Other matching changes were reviewed and excluded as causes: #840 (build DNS
diagnostics), `d3c79e31` (snapshot retention), #911 (deployment domain warnings),
#920 (GitHub connection), #922 and #924 (routing/deployment UI). None changes the
service environment list's ownership or its overrides-only query. #925 is a
separate routing/certificate repair and does not cause this failure.

Older open environment proposals were compared with the current implementation as
well. Their pull requests remain open; this audit does not merge or close them.

| Open proposal                                       | Comparison with current main                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#803](https://github.com/oblien/openship/pull/803) | Preserves project secrets when saving deployment configuration. Main already uses a shared partial project-environment diff with preserved secret values. This proposal does not add the missing effective service read.                                                  |
| [#681](https://github.com/oblien/openship/pull/681) | Proposes service environment Apply through a refresh deployment. Main now has a dedicated service Apply operation; the repair keeps that operation and compares saved values with the running container before offering it.                                               |
| [#677](https://github.com/oblien/openship/pull/677) | Adds provenance for unresolved embedded Compose variables in the earlier API parser. The current shared engine parser preserves that metadata and stores dynamic templates for deployment-time resolution. It does not address the service editor's overrides-only query. |

The earlier source-string “storage ownership” test asserted that the editor used
the override endpoints. It could pass while every saved Compose value was hidden.
It is replaced by behavior tests through the actual component and API/storage path.

## Repair

- One shared engine resolver reads project values, Compose defaults/templates and
  explicit service overrides in deployment order. Apply uses the same resolver.
- The dashboard shows the complete saved view with source labels. Named partial
  edits leave untouched values, ciphertext and row identities intact. Stale source
  IDs reject conflicting writes. Inherited values are not silently pinned.
- Saved reads do not depend on a working Docker daemon. Failed reads never appear
  as an empty environment; failed runtime inspection never claims synchronization.
- Pending status compares values against the owned container and its immutable
  image defaults, including additions and deletions. Apply follows the same runtime
  exclusion rules as deployment. Inspection also keeps the deployment's runtime
  identity: a Cloud workspace's public URL cannot fall back to the control server's
  published port.
- Restart uses that comparison too: changing secret visibility cannot create a
  false pending warning, and removing a variable is detected even after its row is
  gone. Timestamp hints remain a fallback for runtimes without inspection.
- Explicit recovery uses migration's Docker environment provenance rules. It reads
  only the service's current container, excludes image defaults, preserves saved
  values, and requires Save before recovered values become control-plane state.
- The editor retains unsaved values across tabs and uses the active environment
  scope instead of always writing production.

## Verification

The focused tests exercise real React components and real PGlite repositories,
encryption, authorization, HTTP routes and SDK operations. Cases include empty
override tables, inheritance, interpolation, masking/reveal, stale and concurrent
saves, explicit empty values, scope isolation, unavailable Docker, and recovery.

The real Docker suite exercises HTTP/SDK → database → container behavior: recovery
without replacement, changed and removed values, Compose updates, retained secrets,
image identity, sibling uptime, ports, networks and volumes, plus rollback after
failed startup or bookkeeping. Runtime checks use an isolated local daemon.

All five services in the reported live project were checked read-only: the API
has 35 saved variables, PostgreSQL/dashboard/web have three each, and Redis has
none. All five match their running environments. A real browser check also
confirmed 35 API rows, no false empty message, and no unnecessary Apply action.
No production service was restarted or redeployed by this
environment investigation. Exact final verification commands and counts are in the
pull request.
