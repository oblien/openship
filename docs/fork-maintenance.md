# Fork maintenance — the sync worker + image updates

How this fork stays a thin Podman-compatible patch layer on top of
`oblien/openship`, and how the VPS updates from OUR images instead of
`ghcr.io`. Companion to `openship-podman-compatibility.md` (the why); this is
the how. Created with the Option A patches (2026-10).

## The loop

```text
upstream main -> fork-sync -> guards + checks -> sync PR -> merge into fork main
                                                              |
                                                   push fork-v* release tag
                                                              |
                                            fork-images + fork-cli publication
```

Merging or pushing to `main` runs checks but does not publish fork artifacts.
After merging the desired release commit, create and push a release tag, for example:

```sh
git tag fork-v0.9.12-fork.1 <release-commit>
git push origin fork-v0.9.12-fork.1
```

Both fork publishing workflows build that exact commit, even if its package version
matches the preceding commit. Image versions still come from `package.json`; bump
that version when a new versioned artifact is needed. Manual dispatch remains
available. The `fork-v` prefix avoids the upstream `v*.*.*` release workflows and
is distinct from generated `cli-*` tags, so CLI publication cannot trigger itself.

Files that make this up:

| File                                | Role                                                                             |
| ----------------------------------- | -------------------------------------------------------------------------------- |
| `.github/workflows/fork-sync.yml`   | the worker: weekly merge, guards, and sync PR                              |
| `.github/workflows/fork-images.yml` | build `openship-api/dashboard/edge` → our registry (on `fork-v*` tags or manual dispatch) |
| `.github/workflows/fork-cli.yml`    | build the `openship` CLI → GitHub release assets (on `fork-v*` tags or manual dispatch)   |
| `scripts/fork/patch-guard.mjs`      | structural check that the nine patches survived the merge (3 Podman + fork badge + folder-deploy endpoints + hosted-only own domain + podman actions runner + self-app api domain + host-key from= own IP) |

## Where the pipeline runs

Split by weight, not by fashion:

- **`fork-sync.yml` runs on the Openship self-hosted runner** (labels
  `[self-hosted, openship, linux, x64]`) — the dogfood: merge, 7-patch guard
  and the adapters tests all execute on the same rootless-podman destination
  the fsvger pipeline builds on. Safe: it triggers only on schedule and
  manual dispatch, never `pull_request`. Weekly (Sundays 04:23 UTC) plus
  dispatch-anytime — daily churn bought nothing the version gate didn't
  already provide.
- **`fork-images.yml` + `fork-cli.yml` run on GitHub-hosted runners** — free
  on this public repo, and buildx + the GHA layer cache land the images in
  ~7 minutes where the small VPS needed 15–25 even warm. The runner-container
  adaptations in those files (bun instead of system node, in-job gh/go
  bootstrap) no-op on GitHub runners and stay: they make the jobs
  runner-agnostic if the split ever flips back.
- **Every other upstream workflow is disabled** (`gh workflow list` shows
  `disabled_manually`: CI, Catalog health, Docker images, Release, Release
  gate, Scaling E2E) — repo-level settings that survive upstream merges. The
  weekly sync's 7-patch guard + adapters tests are therefore the fork's only
  automated check; re-enable with `gh workflow enable <name>` if a full suite
  run is ever wanted again.

A Garage-S3 builder cache was tried and retired: GHA cache beats it on
GitHub-hosted builds, and the VPS could not reach the bucket (connection
refused). The `--userns=keep-id`/probe work in the runner itself is
unaffected.

## One-time setup

**On the GitHub fork** (Settings → Secrets and variables → Actions):

| Name                  | Kind                | Value                                                                                                                                                              |
| --------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FORK_REGISTRY`       | **variable**        | registry host, e.g. `gitea.example.com` (non-secret config — GitHub variables are the pipeline's ".env"; a committed file would leak the host in this public fork) |
| `FORK_NAMESPACE`      | variable (optional) | namespace under the registry; default `medali`                                                                                                                     |
| `FORK_REGISTRY_USER`  | **secret**          | registry username with push rights                                                                                                                                 |
| `FORK_REGISTRY_TOKEN` | **secret**          | registry token (push auth can never be public)                                                                                                                     |

Or with the `gh` CLI:

```sh
gh variable set FORK_REGISTRY   --repo liodali/openship --body "gitea.example.com"
gh variable set FORK_NAMESPACE  --repo liodali/openship --body "medali"
# push auth stays a secret — never a variable
gh secret set FORK_REGISTRY_USER  --repo liodali/openship
gh secret set FORK_REGISTRY_TOKEN --repo liodali/openship
```

If `FORK_REGISTRY` was ever created as a **secret** (pre-`45db33db` setups),
delete it after creating the variable — the workflow reads the VARIABLE only:

```sh
gh secret delete FORK_REGISTRY --repo liodali/openship
```

Local builds read the same keys from a gitignored `fork.env` — see
[Local builds](#local-builds) below.

Enable Actions on the fork (Actions tab → enable workflows). `schedule:` does
not fire until Actions is enabled; GitHub also pauses cron workflows after 60
days of repo inactivity — the sync's own pushes reset that clock.

**On the VPS** (once, as the rocky user):

```sh
# compose pulls must authenticate to the private registry
podman login gitea.example.com

# point the stack at our images — ~/.openship/compose/.env:
OPENSHIP_IMAGE_REGISTRY=gitea.example.com/medali
OPENSHIP_VERSION=<tag>          # e.g. 0.9.2 or 0.9.2-<shortsha>
```

`OPENSHIP_IMAGE_REGISTRY` is in the CLI's managed-but-sticky set
(`keepConfig` in `apps/cli/src/lib/compose.ts`): every `openship up` /
`openship update` regenerates `.env` but **carries it forward**. Back the file
up before the first update anyway.

## How `openship update` works against our registry

1. `openship update` updates the **CLI binary** from npm (it's plumbing —
   upstream's, not ours).
2. The new CLI re-execs and reconciles the compose install: regenerates
   compose + `.env` (registry preserved), then pulls images and recreates.
3. It repins `OPENSHIP_VERSION` in `.env` to **the CLI's version**
   (`resolveImageVersion`: explicit flag → env → CLI version). That is why the
   worker tags images with the plain upstream version from `package.json` —
   after updating to CLI 0.9.3, the pull resolves to
   `gitea.example.com/medali/openship-api:0.9.3`, i.e. **ours**.
4. If our registry doesn't have that tag yet (upstream released faster than
   the worker), `pinnedImagesReady` aborts **before touching the box**:
   "The pinned image tag isn't in the registry yet". Re-run once the worker
   has built it, or pin explicitly:
   `OPENSHIP_VERSION=0.9.2-<shortsha> openship up --compose`.

Image tags pushed by the worker:

- `<version>` — moving; what `openship update` lands on.
- `<version>-<shortsha>` — immutable; use for pins and rollback.
- `latest` — convenience, avoid pinning to it.

## The fork CLI (GitHub releases, not npm)

The CLI is a separate artifact from the images and embeds the same `packages/sdk`.
The npm package `openship` publishes from **upstream**, so an npm-installed CLI
runs the OLD sdk — `openship deploy --folder` loses the fork fixes. The worker
therefore builds the CLI from the release commit too (`fork-cli.yml`, triggered
by `fork-v*` tags like the images) and publishes it as **GitHub release assets**:

- **`cli-latest`** (moving) — stable install URL, asset replaced every build:

  ```sh
  npm install -g https://github.com/liodali/openship/releases/download/cli-latest/openship-cli-fork.tgz
  ```

- **`cli-<version>-<shortsha>`** (immutable) — the versioned tarball for pins
  and rollback, same convention as the image sha tags.

Why GitHub and not the Gitea npm registry: the package name is unscoped
`openship`, so a scoped registry override can never catch it — using the Gitea
npm registry means switching a machine's GLOBAL npm registry. A release URL
installs with zero npm configuration. (Gitea = images, GitHub = CLI.)

Versioning: the CLI keeps a `-fork.N` suffix (`0.9.2-fork.1`). `compareSemver`
strips prerelease suffixes, so `openship update` — which resolves UPSTREAM
releases — sees the fork build as version-equal and never "updates" it back to
the npm one. After an upstream merge bumps the version (and loses the suffix),
`fork-cli.yml` re-appends `-fork.<run_number>` to both manifests before
building.

**Fork channel (since 0.9.11-fork.1):** `openship update` is fork-aware. A
`*-fork.N` build resolves the latest `cli-<version>-<sha>` release on
`liodali/openship` (never npm, never the upstream tarball payload) and installs
it from the release asset URL — `compareForkVersions` in `@repo/core`
compares the base AND the `-fork.N` suffix, so new fork builds of the same
base also update. The same check watches upstream: when `oblien/openship`
ships a base version newer than the fork's, `openship update --check` prints
a sync notice (the in-CLI twin of fork-drift.yml) instead of installing
upstream. On a compose install whose `.env` still pins the upstream
`OPENSHIP_IMAGE_REGISTRY`, it warns BEFORE reconciling — the fork's images
live in the Gitea registry. ⚠️ Machines still on an OLD fork CLI (pre
fork-channel) keep the old behavior: when upstream ships a genuinely NEW
version, a plain `openship update` there installs the upstream npm build and
silently drops the fork SDK — reinstall from `cli-latest` once.

After any CLI (re)install on the VPS, re-apply the SELinux compose-template
patch: `~/openship-repatch.sh`.

## Day-to-day

Nothing. The worker merges, guards, pushes, builds, and either keeps up or
files an issue. Check the Actions tab if an issue appears.

## Fixing a conflict (the issue loop)

Enable rerere in your local clone — this is the mechanism that makes repeated
conflicts a once-ever cost:

```sh
git config rerere.enabled true
```

Then:

```sh
git fetch upstream                          # oblien/openship
git merge upstream/main                     # conflicts, rerere records them
# resolve in the editor, keep OUR side where upstream only moved code;
# take THEIR side where they genuinely changed behavior
git rerere diff                             # sanity-check the resolutions
git commit
bun install && node scripts/fork/patch-guard.mjs && cd packages/adapters && bunx vitest run src/runtime/docker-builder-mode.test.ts src/runtime/docker-build-cancellation.test.ts src/infra/nginx.test.ts src/infra/edge-baked-conf.test.ts
git push origin main                        # push-trigger builds the images
gh issue close <n>
```

From now on the same file/hunk conflict auto-resolves — locally AND in the
worker, whose `.git/rr-cache` is cached across runs. The worker completes a
fully replayed merge itself (`git commit --no-edit` after rerere stages the
memorized resolutions); it only files an issue when a **novel** conflict
remains.

## When a merge breaks a patch (guard red, merge clean)

Upstream refactored around our patches:

- If they only MOVED code: re-apply our side at the new location, keep the
  guard green.
- If upstream **adopted the same fix** (the endgame): take their version,
  delete that check from `scripts/fork/patch-guard.mjs`, drop our patch. Each
  such merge shrinks the fork toward a pure mirror.

## Rollback on the VPS

```sh
podman login gitea.example.com    # if the token rotated
OPENSHIP_VERSION=0.9.2-<shortsha> openship up --compose
```

The `-<shortsha>` tags are immutable; `<version>` and `latest` move with the
worker.

## Local builds

The same images can be built and pushed from a laptop, no GitHub round-trip:

```sh
cp fork.env.example fork.env   # fill in the real host; gitignored (has the push token)
podman login gitea.example.com   # or put user/token in fork.env

scripts/fork/build-images.sh                 # api + dashboard + edge
scripts/fork/build-images.sh --no-push edge  # build one, don't push
scripts/fork/build-images.sh --tag 0.9.3-rc1 # custom tag
```

Tags follow the CI contract (`<version>`, `<version>-<shortsha>`, `latest`).
Local builds target `linux/amd64` (the VPS) — emulated and slow on arm64 Macs,
so CI remains the cheap path; this is for hand-pushed commits and Dockerfile
experiments.

## Public or private registry?

Gitea container registries can serve packages **publicly** (anonymous pull).
What that buys and costs:

- **Public**: the VPS (or any box) pulls without `podman login` — one less
  setup step, and `pinnedImagesReady`'s `docker manifest inspect` probe works
  anonymously. **Push always needs the token either way** — a public package
  changes nothing about CI auth. Cost: anyone who learns the hostname can pull
  your images and the registry's bandwidth is your VPS's bandwidth.
- **Private** (recommended): `podman login` once per box (the runbook above),
  and the host stays off the public internet's radar.

To go public: Gitea → package (`openship-api` etc.) → Settings → Visibility →
Public. Nothing in this repo changes — the same refs work anonymous.

## Known limits

- **0.9.5 sync learnings (2026-10-26)**: three regressions surfaced when the
  0.9.5 reconcile recreated the whole stack. (1) Edge preflight's new Swarm
  probe breaks on the docker→podman shim — the shim now answers `null` for any
  `.Swarm` format (podman has no swarm); keep that when regenerating the shim.
  (2) Latent `.env` port drift (DASHBOARD_PORT/API_PORT +1 from an old
  auto-shift) applied on recreate while stored edge routes still named the old
  ports — if a domain 502s after an update, compare the edge route's upstream
  port with `podman port <svc>` before anything else. (3) 0.9.5's
  `host-gateway` alias makes pasta forward the container→host channel so sshd
  sees the box's OWN public IP — patch 9 appends it to the provisioned `from=`
  list; the VPS `authorized_keys` also carries it by hand until the next
  re-provision. The `api.<box-domain>` 502 after 0.9.5 is patch 8 (upstream
  guards reserved loopback ports; we exempt the self-app's admin API).
  (4) Full recreates RACE the api's boot route-reapply against the edge
  container's creation ("the edge container is not running", reconcile
  aborts after resolving) — if a domain 502s right after `up --compose`,
  `podman restart openship-api` (once the edge is up) re-runs the reconcile
  and writes the vhosts; confirm with the `[project-route]` api log lines.
- Images are `linux/amd64` only (the VPS is x86_64). Add a platform axis to
  `fork-images.yml` (and native arm runners, like upstream's workflow does)
  before pointing an arm box at the registry.
- The worker builds only `api`, `dashboard`, `edge` — what the VPS compose
  stack runs. `mail`/`webmail`/`cluster-tasks` can be added to the matrix.
- The worker never auto-resolves a NOVEL conflict — it stops clean and files
  an issue. Resolutions are learned from your manual merges (rerere), which
  keeps "our stuff wins" a human decision.
