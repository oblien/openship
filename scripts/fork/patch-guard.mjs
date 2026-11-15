#!/usr/bin/env node
/**
 * Fork patch guard — fails CI the moment one of our Podman-compatibility
 * patches stops being intact after an upstream merge.
 *
 * Run by .github/workflows/fork-sync.yml AFTER `git merge upstream/main` and
 * BEFORE anything is pushed. A structural check, not a test suite: it answers
 * one question fast — "did upstream refactor the exact code our patches
 * live in?" — with a message that names the patch, not a stack trace.
 *
 *   node scripts/fork/patch-guard.mjs
 *
 * The three Podman patches (openship-podman-compatibility.md, Option A):
 *   1. extrahosts JSON        — dockerode build request is spec-correct
 *   2. builder mode/fallback  — OPENSHIP_BUILDER_MODE + /session-404 fallback
 *   3. nginx Connection map   — $connection_upgrade instead of "upgrade"
 * Plus two fork-identity/UX patches:
 *   4. fork badge             — dashboard sidebar marks our build (fork-badge.tsx)
 *   5. folder-deploy routes   — SDK passes scan publicEndpoints to ensure + build/access
 *   6. hosted-only own domain — no synthesized *.opsh.io routes on self-hosted
 *   7. podman actions runner  — daemon probe fallback + runner container flags
 *                              + failed-session retry + bot rerun admission +
 *                              heartbeat sweep (openship-actions-runner-podman-fixes.md)
 *   8. self-app api domain    — api.<box-domain> may route the admin API port
 *                              (0.9.5 guard exempts the dashboard only)
 *   9. host-key from= own IP  — provisioner allowlists the box's own IPv4
 *                              (pasta-forwarded channel source, podman VPS)
 *  10. build SSH submodules   — opt-in OPENSHIP_BUILD_SSH_DIR mount + SSH
 *                              transport for private git@<alias>: submodules
 *
 * WHEN UPSTREAM ADOPTS THE SAME FIX: resolve the merge by taking THEIR version
 * and delete that check here. Every merged upstream PR shrinks the fork back
 * toward a pure mirror — this file is the ledger of what is still ours.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Anchor every path to the repo root (this script lives in scripts/fork/), so
// the guard behaves identically from CI, a monorepo package dir, or anywhere.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => {
  const abs = join(ROOT, p);
  return existsSync(abs) ? readFileSync(abs, "utf8") : null;
};
const failures = [];
const check = (name, ok, hint) => {
  if (!ok) failures.push(hint ? `${name}: ${hint}` : name);
};

// ── Patch 1: extrahosts sent as a JSON array string ─────────────────────────
const dockerTs = read("packages/adapters/src/runtime/docker.ts") ?? "";
check(
  "patch 1 (extrahosts JSON)",
  dockerTs.includes("engineApiExtraHosts(ownershipHost)"),
  "docker.ts no longer routes the build's extrahosts through engineApiExtraHosts() — the bare `host:ip` form is back (Podman 400s the build).",
);
check(
  "patch 1 (no bare extrahosts)",
  !/extrahosts: `\$\{ownershipHost\}/.test(dockerTs),
  "docker.ts contains a bare `extrahosts: `${ownershipHost}:…` literal again — strict daemons reject it.",
);

// ── Patch 2: builder mode + BuildKit /session fallback ──────────────────────
const builderMode = read("packages/adapters/src/runtime/docker-builder-mode.ts") ?? "";
check(
  "patch 2 (module present)",
  builderMode.includes("isBuildKitSessionUnavailable") &&
    builderMode.includes("OPENSHIP_BUILDER_MODE"),
  "docker-builder-mode.ts is missing or no longer exports the /session-404 detector + env resolver.",
);
check(
  "patch 2 (regex tolerates the real status line)",
  // String-contains, deliberately: the needle is the literal SOURCE text of the
  // matcher (escaped for JS), which exists only in the code line — a regex test
  // would also match the prose in the doc comment, where the same words appear
  // unescaped, and pass even when the code was tampered with (found the hard way).
  builderMode.includes("docker \\/session failed: (?:HTTP\\/[\\d.]+ )?40[45]"),
  "the /session matcher no longer tolerates the 'HTTP/1.1 ' prefix upgradeRequest() emits — the fallback is dead again.",
);
check(
  "patch 2 (wired into docker.ts)",
  dockerTs.includes("isBuildKitSessionUnavailable") &&
    dockerTs.includes("resolveDockerodeBuilderMode"),
  "docker.ts no longer imports/uses the builder-mode module — no fallback, no OPENSHIP_BUILDER_MODE.",
);
check(
  "patch 2 (Podman probe wired)",
  dockerTs.includes("probeDaemonSkipsBuildKit") &&
    dockerTs.includes("daemonSupportsBuildKitSession"),
  "docker.ts no longer probes the daemon via /version before the BuildKit attempt — on Podman the doomed attempt (and its tainted-connection retry) is back.",
);
check(
  "patch 2 (fresh connection on the classic retry)",
  dockerTs.includes("useFreshBuildConnection"),
  "docker.ts no longer swaps the modem agent on the BuildKit→classic fallback — the retry reuses the aborted upload's pooled socket and ships an EMPTY context on Podman (libpod_builder 'Dockerfile: no such file').",
);
check(
  "patch 2 (env documented)",
  (read(".env.example") ?? "").includes("OPENSHIP_BUILDER_MODE"),
  ".env.example no longer documents OPENSHIP_BUILDER_MODE.",
);

// ── Patch 3: nginx Connection follows the request ───────────────────────────
const nginxTs = read("packages/adapters/src/infra/nginx.ts") ?? "";
check(
  "patch 3 (header uses the map variable)",
  nginxTs.includes("proxy_set_header Connection $connection_upgrade;"),
  "PROXY_HEADERS no longer sends `Connection $connection_upgrade` — the unconditional literal (Dart/shelf empty-POST bug) is back.",
);
check(
  "patch 3 (vhost carries its own map)",
  nginxTs.includes("EDGE_CONNECTION_UPGRADE_MAP") &&
    nginxTs.includes('serverBlock.includes("$connection_upgrade")'),
  "writeRoute no longer prepends EDGE_CONNECTION_UPGRADE_MAP to vhosts that reference the variable — confs fail openresty -t on older edge images.",
);
check(
  "patch 3 (map defined once, shared)",
  (read("packages/adapters/src/infra/openresty-lua.ts") ?? "").includes(
    "EDGE_CONNECTION_UPGRADE_MAP",
  ),
  "EDGE_CONNECTION_UPGRADE_MAP vanished from openresty-lua.ts.",
);
check(
  "patch 3 (baked conf regenerated)",
  (read("apps/edge/nginx.conf") ?? "").includes("map $http_upgrade $connection_upgrade {"),
  "apps/edge/nginx.conf no longer defines the map — regenerate with `bun run edge:conf` in packages/adapters.",
);

// ── Patch 6: the platform's own (*.opsh.io) domain is hosted-only ────────────
// Self-hosted boxes without HOST_DOMAIN must not have free *.opsh.io routes
// synthesized next to the user's custom domain — the routing base falls back
// to CLOUD_DOMAIN, an edge this box never serves. Gated by
// managedFreeRoutingAvailable() at every synthesis site.
const routingDomainsTs = read("packages/platform/src/engine/lib/routing-domains.ts") ?? "";
const publicEndpointsTs = read("packages/platform/src/engine/lib/public-endpoints.ts") ?? "";
check(
  "patch 6 (own domain is hosted-only)",
  routingDomainsTs.includes("export function managedFreeRoutingAvailable") &&
    routingDomainsTs.includes("if (!usesManagedRouting || !managedFreeRoutingAvailable()) return null;") &&
    publicEndpointsTs.includes("managedFreeRoutingAvailable"),
  "the managed-free-routing gate vanished — synthesized *.opsh.io routes are back next to users' custom domains on self-hosted boxes (routing-domains.ts / public-endpoints.ts).",
);

// ── Patch 5: folder-deploy carries declared domains to the deploy API ────────
// The SDK's source workflow dropped the scan's publicEndpoints, so a
// self-hosted `openship deploy --folder` with declared domains 403'd at the
// Cloud preflight ("Connect Openship Cloud to use a free subdomain").
const sourceWorkflowTs = read("packages/sdk/src/source-workflow.ts") ?? "";
check(
  "patch 5 (folder-deploy passes publicEndpoints)",
  sourceWorkflowTs.includes("publicEndpoints.map(buildAccessEndpoint)") &&
    sourceWorkflowTs.includes("...(publicEndpoints?.length ? { publicEndpoints } : {})") &&
    sourceWorkflowTs.includes("webSingleApp"),
  "source-workflow.ts no longer forwards the scan's publicEndpoints to projects/ensure + deployments/build/access, or lost the single-app web-workload derivation — self-hosted folder deploys fail the Cloud preflight / the static-port preflight again.",
);

// ── Patch 4: fork badge visible in the dashboard sidebar ────────────────────
// Not a Podman patch — a fork IDENTITY marker. The daily worker's promise is
// "you can always tell you're on our build"; an upstream sidebar refactor that
// silently drops the badge breaks that promise, so it gets the same guard.
const sidebarTsx = read("apps/dashboard/src/components/sidebar.tsx") ?? "";
check(
  "patch 4 (fork badge in sidebar)",
  read("apps/dashboard/src/components/fork-badge.tsx") !== null &&
    sidebarTsx.includes('from "@/components/fork-badge"'),
  "the sidebar no longer mounts ForkBadge — an upstream refactor of the sidebar header dropped our fork marker (apps/dashboard/src/components/fork-badge.tsx).",
);

// ── Patch 7: GitHub Actions runner on rootless Podman ───────────────────────
// The whole fix set from openship-actions-runner-podman-fixes.md, absorbed so
// the hand-made /usr/local/bin/docker shim could retire. Upstream owns every
// file it lives in, and the actions module is under active development — a
// merge that rewrites any of them can drop a fix WITHOUT conflicting, so each
// arm is guarded structurally.
const catalogTs = read("packages/adapters/src/system/catalog.ts") ?? "";
check(
  "patch 7 (daemon probe tolerates podman)",
  catalogTs.includes("docker info --format '{{.ServerVersion}}' 2>/dev/null ||") &&
    catalogTs.includes("{{.Version.Version}}"),
  "catalog.ts lost the Podman daemon-probe fallback — the server check reports docker unhealthy again and the actions dispatcher never starts jobs on the podman VPS.",
);
const githubGo = read("packages/actions-runner/github.go") ?? "";
check(
  "patch 7 (runner container tolerances)",
  githubGo.includes("DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1") &&
    githubGo.includes('"--userns=keep-id"') &&
    githubGo.includes('"--security-opt", "label=disable"') &&
    githubGo.includes("if isRootlessPodman() {") &&
    githubGo.includes("if isSELinuxEnforcing() {"),
  "githubContainerArgs lost keep-id / invariant-globalization / label=disable — Runner.Listener dies on Permission denied (subuid mapping), aborts 134 without libicu, or is denied connectto to the docker proxy on the podman VPS.",
);
// Patch "failed sessions retry with backoff" (ACTIONS_RUNNER_SESSION_ATTEMPTS/
// RETRY_MS) was RETIRED at v0.9.11: upstream #1509 + #1541 superseded it with a
// poison-guard (`if (previous) return` in reserveRunnerSession — a failed
// session blocks re-reservation until explicit retry/rerun) plus spare-session
// reuse. Upstream's design replaces the fork's bounded retry; no check needed.
const runAccessTs = read("packages/platform/src/engine/modules/actions/run-access.ts") ?? "";
check(
  "patch 7 (bot actor admitted for API reruns)",
  runAccessTs.includes("systemInitiated") && runAccessTs.includes("gitHubRunCommand"),
  "evaluateActionRunAdmission lost the command-receipt arm — API reruns execute as the GitHub App bot, fail a selected-user audience, and park forever.",
);
check(
  "patch 7 (runner heartbeat sweep)",
  (read("packages/platform/src/engine/modules/actions/runner.service.ts") ?? "").includes(
    "export async function probeActionRunnerSweep",
  ) &&
    (read("packages/platform/src/engine/modules/actions/lifecycle.ts") ?? "").includes(
      "probeActionRunnerSweep",
    ),
  "the checkedAt heartbeat sweep vanished from runner.service.ts / lifecycle.ts — a frozen checkedAt reads as a runner outage again.",
);
check(
  "patch 7 (dispatcher skips are logged)",
  (read("packages/platform/src/engine/modules/actions/github-runners.ts") ?? "").includes(
    "noteDispatchSkip",
  ),
  "reserveDemand lost noteDispatchSkip — jobs sit undispatched silently again (the frozen-dispatch incident shape).",
);

// ── Patch 8: self-app may route its own admin API port ──────────────────────
// 0.9.5 refuses public routes at reserved loopback ports (admin API, dashboard,
// OpenResty mgmt) with a self-app exemption for the dashboard ONLY. Our box also
// fronts the admin API on api.<domain> through the edge (operator's choice on a
// single-tenant self-hosted install; what 0.9.3 did before the guard existed).
const projectRouteTs = read("packages/platform/src/engine/modules/domains/project-route.service.ts") ?? "";
check(
  "patch 8 (self-app api domain exempt)",
  projectRouteTs.includes("const ownApi = opts.isSelfApp && port === env.PORT;") &&
    projectRouteTs.includes("!ownDashboard && !ownApi"),
  "shouldRefuseLoopbackRoute lost the self-app env.PORT exemption — api.<box-domain> 502s again ('refusing reserved loopback upstream port' for a public route).",
);

// ── Patch 9: host-executor key from= includes the box's own IP ───────────────
// Rootless podman's pasta gateway forwards the container→host channel through
// the host stack, so sshd attributes the connection to the box's own primary
// IPv4 — outside the RFC1918-only from= list the provisioner writes. Without
// this, every (re)provision silently breaks the channel again.
const composeCliTs = read("apps/cli/src/lib/compose.ts") ?? "";
check(
  "patch 9 (host key from= includes own IP)",
  composeCliTs.includes("function ownPrimaryIpv4()") &&
    composeCliTs.includes("function hostKeyFromList()") &&
    composeCliTs.includes("from=\"${hostKeyFromList()}\""),
  "hostKeyAuthLine lost the own-IP from= extension — a re-provision on the podman VPS re-breaks the container→host SSH channel (correct key, 'not from a permitted host').",
);

// ── Patch 10: private SSH submodules on the api-host clone ─────────────────
// Our repos keep `.gitmodules` on git@<alias>: URLs (one read-only deploy key
// per submodule; changing them to HTTPS is a security regression for the dev
// machines). The scoped token clone is HTTPS-only, so the operator can mount a
// build SSH directory and the clone uses it for those submodule URLs.
const gitCloneTs = read("packages/adapters/src/runtime/git-clone.ts") ?? "";
check(
  "patch 10 (build SSH identity)",
  gitCloneTs.includes("OPENSHIP_BUILD_SSH_DIR") &&
    gitCloneTs.includes("function buildSshCommand") &&
    gitCloneTs.includes("protocol.ssh.allow") &&
    gitCloneTs.includes('https:ssh'),
  "git-clone.ts lost the opt-in build SSH identity (OPENSHIP_BUILD_SSH_DIR) — private submodules pinned to git@<alias>: URLs fail again with \"transport 'ssh' not allowed\".",
);
check(
  "patch 10 (compose mounts it)",
  composeCliTs.includes("BUILD_SSH_MOUNT_MARKER") &&
    composeCliTs.includes("resolveBuildSshDir") &&
    composeCliTs.includes("target: /root/.ssh") &&
    composeCliTs.includes('OPENSHIP_BUILD_SSH_DIR: "/root/.ssh"'),
  "compose.ts no longer renders the read-only build SSH mount / container env — the API has no keys for SSH submodule URLs.",
);
check(
  "patch 10 (env documented)",
  (read(".env.example") ?? "").includes("OPENSHIP_BUILD_SSH_DIR"),
  ".env.example no longer documents OPENSHIP_BUILD_SSH_DIR.",
);

if (failures.length > 0) {
  console.error("\n✖ fork patch guard: a patch no longer looks intact after the merge.\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nEither fix the merge (keep our side where upstream merely moved code), or — if\n" +
      "upstream adopted the same fix — take THEIR version and delete that check from\n" +
      "scripts/fork/patch-guard.mjs. Nothing was pushed.\n",
  );
  process.exit(1);
}
console.log(
  "✔ fork patch guard: all ten patches intact (extrahosts JSON, builder fallback, nginx Connection map, fork badge, folder-deploy endpoints, hosted-only own domain, podman actions runner, self-app api domain, host-key from= own IP, build SSH submodules).",
);
