# Cloud host execution boundary

Reviewed 2026-11-04 against the branch based on `8c76cf8f2` (main).
This is a focused source/transport review, not a complete penetration test or a
claim that the repository contains no other vulnerabilities.

Managed customer commands belong in the owned provider VM through its scoped
executor. Connected external servers use their authorized SSH executor. A missing
or failing destination must stop the operation; it must not select the API host.
Self-hosted installations and Desktop retain their explicit local execution.

## Changes from this review

- A single `assertLocalHostExecutionAllowed` policy in core refuses `CLOUD_MODE=true`
  and `CLOUD_MODE=1` at use time, including for previously constructed executors.
- Local shell execution, local build staging, implicit bare-runtime construction,
  local Docker-socket construction/connection, local Nginx/certbot commands,
  local harness discovery/startup and host GitHub-token probes enforce this floor.
- Cloud domain-claim checks no longer probe the shared control plane's edge.
- The command-availability probe passes the executable name as a positional
  argument rather than inserting it into shell source.

These are additional guards beneath the existing organization, namespace,
server/project permission and destination checks. The review did not establish a
Cloud tenant path to the original PR #1611 local streaming addition. That PR's
author subsequently reverted the addition; its current diff is empty. The missing
`rawExec` method alone is not an execution boundary: `LocalExecutor.exec` and
`streamExec` already invoke shells.

## Scan coverage and remaining local tools

A one-off AST scan reviewed 3623 JavaScript/TypeScript source files and 141
process-launch sites across `apps` and `packages`, including mail trees and runner
assets outside `src`. Tests, dependency trees, generated output and script
directories were excluded. The scan covered child_process imports/calls, common
aliases and promisified calls, Bun/Deno launches and embedded harness wrappers.
The scan scripts and per-function inventory are retained with the review artifacts;
they do not add a new runtime abstraction or a CI maintenance gate.

The inventory includes legitimate processes; removing all process creation would
break local installations and remote transports:

| Group                                 | Execution boundary                                                                                                                      |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| CLI and Desktop                       | Operator-owned launch, installation, repair and update workflows; not SaaS request handlers.                                            |
| Local workload/agent/routing commands | Refused on the Cloud controller by the shared floor.                                                                                    |
| Managed applications                  | Provider-backed `CloudWorkspaceExecutor`, scoped to the owned VM/namespace; no local retry.                                             |
| SSH, Cloudflare and rsync clients     | Fixed local transport binaries and argv; authorized external-server commands execute remotely. Managed VM commands use the provider.    |
| Git/tar archive tools                 | Fixed tools and argv for source/archive handling. Managed builds reject API-host source paths and run application build/hooks remotely. |
| Cluster database jobs                 | Fixed database utilities inside generated cluster Job workers.                                                                          |
| Embedded DB locks and OS probes       | Installation-local identity/locking tools, not tenant shell commands. SaaS uses PostgreSQL.                                             |
| Package-manager bootstrap             | Installer/build-worker program with fixed tool argv; not an exported tenant API executor.                                               |

A separate search found a `new Function` built exclusively from the repository's
constant Node output preparer and a generated remote `eval` whose script is encoded
from that constant plus JSON-serialized options. These are reviewed generated
programs, not arbitrary API-host evaluation of user-supplied JavaScript.

Static inventory cannot prove input taint, discover all indirect third-party
process launches, or establish every caller's authorization. Keep the runtime
Cloud refusal and scoped transport/permission regression tests.

## Validation

Behavioral tests verify refusal before shell execution, filesystem build staging,
local daemon creation and local agent state creation. Tests also cover command-name
injection, safe SSH preflight in Cloud, unchanged local execution, retained provider errors, managed bare/Docker
transports, Cloud destination isolation and early refusal of local edge probes.
