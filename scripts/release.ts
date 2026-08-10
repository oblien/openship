#!/usr/bin/env bun
/**
 * Cut a new Openship release.
 *
 * Usage:
 *   bun scripts/release.ts patch          # 0.1.0      → 0.1.1
 *   bun scripts/release.ts minor          # 0.1.0      → 0.2.0
 *   bun scripts/release.ts major          # 0.1.0      → 1.0.0
 *   bun scripts/release.ts rc             # 0.1.0      → 0.1.1-rc.1
 *                                         # 0.1.1-rc.1 → 0.1.1-rc.2
 *                                         # 0.1.1-rc.2 → 0.1.1     (promote: rc → stable)
 *   bun scripts/release.ts <explicit>     # set to literal "0.2.0-beta.3"
 *   bun scripts/release.ts --dry-run patch
 *
 *   bun run release                       # NO args in a terminal → interactive
 *                                         # wizard over every option below. It
 *                                         # prints the equivalent command and
 *                                         # re-runs itself with it, so there is
 *                                         # one code path. Non-TTY (CI/pipes)
 *                                         # keeps the no-arg behaviour: release
 *                                         # the current version as-is.
 *
 *   bun scripts/release.ts docker [tag]   # publish Docker images ONLY (GHCR),
 *                                         # via the docker-images workflow. A
 *                                         # test/prerelease image build: NO version
 *                                         # bump, NO git tag, NO GitHub release, NO
 *                                         # npm/desktop, and it never moves :latest.
 *                                         # Omit [tag] → images tagged with the short
 *                                         # SHA. `--ref=<branch>` builds that branch.
 *
 * What it does:
 *   1. Refuse if working tree is dirty
 *   2. Refuse if not on main (override with --force-branch)
 *   3. Refuse if HEAD is behind origin/main (you'd push an old commit)
 *   4. Compute next version from apps/api/package.json
 *   5. Sync both root package.json and apps/api/package.json
 *   6. Commit "Bump to vX.Y.Z"
 *   7. Push the bump commit to main
 *   8. Tag vX.Y.Z and push the tag
 *   9. Print the GitHub Actions URL so you can watch
 *
 * The tag-push triggers .github/workflows/release.yml which builds both
 * dist tarballs + SHA-256 sidecars and publishes a GitHub Release.
 * Tags containing `-` (rc.N, beta.N) become prereleases automatically.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWizardArgs, type WizardAnswers } from "./release-args";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT_PKG = join(ROOT, "package.json");
const API_PKG = join(ROOT, "apps/api/package.json");
// The upgrade-prompt gate. A release ships SILENTLY unless `publish` writes an
// advisory here for the new version (see release-advisories.json's $comment).
const ADVISORIES = join(ROOT, "release-advisories.json");
// Every package.json whose version should track the release. API is the
// operative source the next version is computed from; the rest are synced to
// match so the desktop app (forge reads apps/desktop/package.json), web,
// email, and the npm-published CLI all report the same version as the tag.
const SYNCED_PKGS = [
  ROOT_PKG,
  API_PKG,
  join(ROOT, "apps/desktop/package.json"),
  join(ROOT, "apps/web/package.json"),
  join(ROOT, "apps/email/package.json"),
  join(ROOT, "apps/cli/package.json"),
];

/* ─── CLI parsing ──────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const forceBranch = args.includes("--force-branch");
// `--force` re-releases a tag that ALREADY exists: instead of refusing, delete
// it (local + origin) and re-push, firing a fresh release run. Off by default
// and explicit on purpose — re-pointing a tag people may already have pulled
// silently diverges their bytes. The safe use is salvaging a tag whose release
// failed and published nothing (see the refusal block below).
const force = args.includes("--force");
if (args.includes("--help") || args.includes("-h")) usageAndExit(0);

// `publish` is the announcement switch. Without it a release ships SILENTLY —
// no in-app banner (users still see "vX available" in Settings → Updates and the
// home Updates block). WITH it, we write a release advisory for this version
// into release-advisories.json (committed + pinned to the tag), which is the
// ONLY thing that raises the update banner for users below this version.
//   bun run release patch            → silent
//   bun run release patch publish    → announced (recommended)
//   bun run release patch publish --critical            → critical (always shown)
//   bun run release patch publish --message="…"         → custom banner body
const publish = args.includes("publish");
const critical = args.includes("--critical");
const message = args.find((a) => a.startsWith("--message="))?.slice("--message=".length);
// Who the announcement is FOR. Omitted → every install kind (the legacy
// default). Values must match @repo/core's AdvisoryMode, since clients filter on
// them: "desktop" (the Electron app), "selfhosted" (VPS: compose or bare),
// "cloud" (the managed SaaS). A desktop-installer fix is noise on a VPS.
const ADVISORY_MODES = ["desktop", "selfhosted", "cloud"] as const;
type ReleaseMode = (typeof ADVISORY_MODES)[number];
const modesArg = args.find((a) => a.startsWith("--modes="))?.slice("--modes=".length);
const modes: ReleaseMode[] | undefined = modesArg
  ? modesArg
      .split(",")
      .map((m) => m.trim().toLowerCase())
      .filter(Boolean) as ReleaseMode[]
  : undefined;
if (modes) {
  const bad = modes.filter((m) => !ADVISORY_MODES.includes(m));
  if (bad.length > 0) {
    console.error(
      `Refusing --modes=${modesArg}: unknown mode(s) ${bad.join(", ")}. ` +
        `Valid: ${ADVISORY_MODES.join(", ")} (omit --modes for all).`,
    );
    process.exit(1);
  }
  if (!publish) {
    console.error(
      `Refusing --modes without \`publish\`: modes scope an ANNOUNCEMENT, and a ` +
        `silent release has none. Add \`publish\`, or drop --modes.`,
    );
    process.exit(1);
  }
}
// The bump is the first positional that ISN'T the `publish` switch.
const cmd = args.find((a) => !a.startsWith("--") && a !== "publish");

/* ─── Interactive mode ─────────────────────────────────────────────────
 *
 * `bun run release` with NO arguments, in a terminal, walks the same option
 * surface as the flags. It builds an argv and RE-EXECUTES this script with it —
 * so the release logic below has exactly one entry shape and can't drift from
 * the flag path. It also prints the equivalent command, so the wizard teaches
 * the flags instead of hiding them.
 *
 * Non-TTY (CI, pipes) keeps the documented no-arg behaviour: release the current
 * version as-is. Any argument at all also skips the wizard.
 */
if (args.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
  const chosen = await runWizard();
  if (!chosen) {
    log("Cancelled — nothing was released.");
    process.exit(0);
  }
  log("");
  log(`▶ bun run release ${chosen.join(" ")}`);
  log("");
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...chosen], {
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
}

// `docker` is a SEPARATE path: publish container images ONLY (via the
// docker-images workflow) — no version bump, no git tag, no GitHub release.
// Branch out here, before any version/semver handling treats "docker" as a bump.
if (cmd === "docker") {
  releaseDocker();
  process.exit(0);
}

type BumpKind = "patch" | "minor" | "major" | "rc" | "current" | "literal";
// No arg (or "current") → release the version already in package.json as-is,
// no bump. Otherwise bump / set the version.
const bump: { kind: BumpKind; literal?: string } =
  !cmd || cmd === "current"
    ? { kind: "current" }
    : cmd === "patch" || cmd === "minor" || cmd === "major" || cmd === "rc"
      ? { kind: cmd }
      : { kind: "literal", literal: cmd };

if (bump.kind === "literal" && !/^\d+\.\d+\.\d+(-[a-z0-9]+(\.\d+)?)?$/i.test(bump.literal!)) {
  console.error(`Refusing literal version "${bump.literal}" — not a semver string.`);
  process.exit(1);
}

/* ─── Pre-flight checks ────────────────────────────────────────────── */

if (!dryRun) {
  preflight();
}

/* ─── Version compute ──────────────────────────────────────────────── */

const currentApi = readVersion(API_PKG);
const currentRoot = readVersion(ROOT_PKG);
if (currentApi !== currentRoot) {
  log(
    `⚠️  Version drift detected: root=${currentRoot}, apps/api=${currentApi}. ` +
      `Bumping from apps/api's (operative) value.`,
  );
}

const next = computeNext(currentApi, bump);
const tag = `v${next}`;

if (publish && tag.includes("-")) {
  console.error(
    `Refusing: "publish" announces a STABLE release, but ${tag} is a prerelease ` +
      `(rc/beta). Clients only pull advisories from the latest STABLE release, so a ` +
      `prerelease announcement is never seen. Drop "publish" for the rc, or promote to ` +
      `stable and publish that.`,
  );
  process.exit(1);
}

log(`Current version (apps/api): ${currentApi}`);
log(`Next version:               ${next}`);
log(`Tag:                        ${tag}`);
log(`Prerelease:                 ${tag.includes("-") ? "yes" : "no"}`);
log(`Announcement:               ${publish ? `yes (${critical ? "critical" : "recommended"} advisory)` : "no — silent release"}`);
if (publish) {
  log(`Audience:                   ${modes ? modes.join(", ") : "all installs (desktop, selfhosted, cloud)"}`);
}
log(``);

if (dryRun) {
  if (bump.kind === "current") {
    log(`[dry-run] would tag the current version (no bump) and push ${tag}`);
  } else {
    log(`[dry-run] would update:`);
    for (const p of SYNCED_PKGS) log(`  - ${p}`);
    log(`[dry-run] would commit + push, then tag + push ${tag}`);
  }
  if (publish) {
    log(`[dry-run] would write an announcement advisory to release-advisories.json:`);
    log(JSON.stringify(buildAdvisory(next, { critical, message, modes }), null, 2));
  }
  if (force && tagExists(tag)) {
    log(`[dry-run] --force: tag ${tag} exists → would DELETE it (local + origin) and re-push`);
  }
  log(`[dry-run] no files written, no git ops executed.`);
  process.exit(0);
}

if (tagExists(tag)) {
  if (!force) {
    console.error(
      `Refusing: tag ${tag} already exists. ` +
        (bump.kind === "current"
          ? `Bump the version (patch/minor/major), or pass --force to re-release ${tag}.`
          : `Pick a different version, or pass --force to re-release ${tag}.`),
    );
    process.exit(1);
  }
  // --force: salvage an existing tag. Delete it locally AND on origin so the
  // `git tag` + push below create a FRESH ref — a same-SHA re-push reports
  // "up-to-date" and fires no workflow, which is exactly why a plain re-run of
  // an existing tag does nothing.
  log(`⚠ --force: tag ${tag} exists — deleting it (local + origin) to re-release`);
  retireExistingTag(tag);
}

/* ─── Apply ─────────────────────────────────────────────────────────── */

// Files to stage into the (single) release commit. Version bumps + the
// announcement advisory both ride the SAME commit so the advisory is pinned to
// the tag clients pull.
const staged: string[] = [];

if (bump.kind !== "current") {
  for (const p of SYNCED_PKGS) writeVersion(p, next);
  log(`✓ updated ${SYNCED_PKGS.length} package.json files`);
  staged.push(...SYNCED_PKGS);
}

if (publish) {
  const { entry, replaced } = writeAdvisory(next, { critical, message, modes });
  log(`✓ wrote announcement advisory "${entry.id}" (${entry.severity})`);
  if (replaced.length) {
    log(`  replaced previous advisory(ies): ${replaced.join(", ")}`);
  }
  staged.push(ADVISORIES);
}

if (staged.length > 0) {
  git("add", ...staged);
  // Only commit if something actually changed. Re-releasing the version you're
  // already on (no bump, no publish diff) writes no diff, and `git commit` would
  // abort with "nothing to commit" and kill the release — ship as-is instead.
  const nothingStaged =
    spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: ROOT }).status === 0;
  if (nothingStaged) {
    log(`No changes to commit — releasing as-is.`);
  } else {
    const msg = publish
      ? bump.kind === "current"
        ? `Announce ${tag}`
        : `Bump to ${tag} + announce`
      : `Bump to ${tag}`;
    git("commit", "-m", msg);
    log(`✓ committed`);
  }
}

git("push", "origin", `refs/heads/${currentBranch()}`);
log(`✓ pushed ${currentBranch()}${bump.kind === "current" && !publish ? " (releasing current version, no bump)" : ""}`);

git("tag", tag);
// Fully-qualified refspec: a BRANCH sharing the tag's name (e.g. a leftover
// `v0.2.0` branch) would otherwise make `git push origin v0.2.0` ambiguous
// ("src refspec … matches more than one").
git("push", "origin", `refs/tags/${tag}`);
log(`✓ pushed tag ${tag} — CI is building installers for macOS, Windows & Linux`);

/* ─── Final report ─────────────────────────────────────────────────── */

const remoteUrl = git("remote", "get-url", "origin", { capture: true }).trim();
const ghMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
const actionsUrl = ghMatch ? `https://github.com/${ghMatch[1]}/${ghMatch[2]}/actions` : "";
if (ghMatch) {
  const [, owner, repo] = ghMatch;
  log(``);
  log(`Release will appear at:`);
  log(`  https://github.com/${owner}/${repo}/releases/tag/${tag}`);
  log(``);
}

// Stream the live build status right here in the terminal.
watchCi(tag, actionsUrl);

/* ─── Helpers ──────────────────────────────────────────────────────── */

function usageAndExit(code = 1): never {
  const out = code === 0 ? console.log : console.error;
  out(
    [
      "Usage: bun run release [current|patch|minor|major|rc|x.y.z[-rc.N]] [publish [--critical] [--modes=…] [--message=…]] [--dry-run] [--force-branch]",
      "",
      "  (no arg)       in a terminal: interactive wizard over all of the below.",
      "                 non-interactive (CI/pipe): release the current version as-is",
      "  current        same as no arg",
      "  patch          0.1.0      → 0.1.1",
      "  minor          0.1.0      → 0.2.0",
      "  major          0.1.0      → 1.0.0",
      "  rc             0.1.0      → 0.1.1-rc.1",
      "                 0.1.1-rc.1 → 0.1.1-rc.2",
      "                 0.1.1-rc.2 → 0.1.1   (rc → stable promotion)",
      "  <literal>      explicit semver string",
      "",
      "  docker [tag]   publish Docker images ONLY (GHCR) via the docker-images",
      "                 workflow — no version bump / git tag / GitHub release, and",
      "                 never moves :latest. Omit [tag] → images tagged short SHA.",
      "                 `--ref=<branch>` builds that branch (default: current).",
      "                 e.g.  bun run release docker 0.0.0-rc.1",
      "",
      "  publish        ANNOUNCE this release: write a release advisory so the in-app",
      "                 update banner prompts users below this version. WITHOUT it the",
      "                 release ships SILENTLY (still shown quietly in Settings → Updates",
      "                 and the home Updates block). Refused for prereleases.",
      "    --critical   make the announcement critical (always shown, even if muted)",
      "    --modes=…    WHO sees it: comma list of desktop|selfhosted|cloud.",
      "                 Omit for all installs. Clients filter on this, so a",
      "                 desktop-installer notice never reaches a VPS dashboard",
      "                 (and an edge/compose notice never reaches the desktop app).",
      "                 e.g. --modes=selfhosted   --modes=desktop,cloud",
      "    --message=…  custom banner body (default points at the release notes)",
      "",
      "  e.g.  bun run release patch                    # silent patch",
      "        bun run release minor publish            # announced (recommended)",
      "        bun run release patch publish --critical # announced (critical)",
      "",
      "  --dry-run      print the plan, don't touch anything (with `publish`, also",
      "                 prints the exact advisory JSON that would be written)",
      "  --force-branch run from a non-main branch (default refuses)",
      "  --force        re-release an EXISTING tag: delete it (local + origin) and",
      "                 re-push, firing a fresh build. For salvaging a tag whose",
      "                 release failed. Refuses without it (re-pointing a pulled",
      "                 tag diverges users' bytes).",
      "  --help, -h     show this help",
      "",
      "In every case CI builds installers for macOS (arm64 + x64), Windows,",
      "and Linux and publishes them to the GitHub release. Live build status",
      "streams here after the tag is pushed (needs the `gh` CLI, logged in).",
    ].join("\n"),
  );
  process.exit(code);
}

/** True if the tag already exists locally or on origin. */
function tagExists(t: string): boolean {
  const local = git("tag", "--list", t, { capture: true }).trim();
  if (local) return true;
  const remote = git("ls-remote", "--tags", "origin", t, { capture: true }).trim();
  return remote.length > 0;
}

/** Delete a tag wherever it exists (local + origin) so it can be re-pushed as a
 *  FRESH ref. Each side is guarded on presence — `git()` exits on any non-zero,
 *  so deleting a side that isn't there would abort the release. */
function retireExistingTag(t: string): void {
  if (git("tag", "--list", t, { capture: true }).trim()) {
    git("tag", "-d", t);
    log(`  ✓ deleted local tag ${t}`);
  }
  if (git("ls-remote", "--tags", "origin", t, { capture: true }).trim()) {
    git("push", "origin", `:refs/tags/${t}`);
    log(`  ✓ deleted origin tag ${t}`);
  }
}

/**
 * Stream the live status of the release workflow run into this terminal.
 * Uses the `gh` CLI (`gh run watch`), which shows each job spinning →
 * pass/fail and exits when the run finishes. Degrades gracefully (prints the
 * Actions URL) if `gh` is missing, not authed, or the run isn't found yet.
 */
function watchCi(t: string, fallbackUrl: string): void {
  const have = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (have.status !== 0) {
    if (fallbackUrl) log(`Watch the build:  ${fallbackUrl}`);
    return;
  }

  log(`Waiting for the release run to register on GitHub…`);
  let runId = "";
  for (let i = 0; i < 15 && !runId; i++) {
    Bun.sleepSync(4000);
    const out = spawnSync(
      "gh",
      ["run", "list", "--workflow", "release.yml", "--limit", "15", "--json", "databaseId,headBranch,event,createdAt"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (out.status !== 0) continue;
    try {
      const runs = JSON.parse(out.stdout ?? "[]") as Array<{
        databaseId: number;
        headBranch: string;
        event: string;
      }>;
      // Tag-triggered runs show headBranch === the tag name.
      const match = runs.find((r) => r.headBranch === t || r.headBranch === `refs/tags/${t}`);
      if (match) runId = String(match.databaseId);
    } catch {
      // keep polling
    }
  }

  if (!runId) {
    log(`Couldn't locate the run automatically.`);
    if (fallbackUrl) log(`Watch the build:  ${fallbackUrl}`);
    return;
  }

  log(``);
  log(`▼ live build status (Ctrl-C to stop watching — the build keeps running):`);
  log(``);
  // Streams job-by-job status and exits when the run completes.
  spawnSync("gh", ["run", "watch", runId, "--interval", "6"], { cwd: ROOT, stdio: "inherit" });
  log(``);
  spawnSync("gh", ["run", "view", runId], { cwd: ROOT, stdio: "inherit" });
}

/* ─── Docker image release (GHCR-only, via workflow_dispatch) ────────── */

/** owner/repo parsed from origin, or null when origin isn't a GitHub remote. */
function ghOwnerRepo(): { owner: string; repo: string } | null {
  const url = git("remote", "get-url", "origin", { capture: true }).trim();
  const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * `bun release docker [tag]` — trigger the docker-images workflow to publish the
 * openship-api/dashboard/edge images to GHCR. This is the DOCKER-ONLY path: it
 * dispatches the workflow (no version bump, no git tag, no GitHub release, no
 * npm/desktop) and the dispatch run never moves `:latest`. Untracked/dirty tree
 * is fine — it builds whatever is on the pushed `--ref` branch, not your working
 * copy. Requires the `gh` CLI (or use the Actions UI → "Docker images").
 */
function releaseDocker(): void {
  const positionals = args.filter((a) => !a.startsWith("--") && a !== "publish");
  const dockerTag = positionals[1]; // `release docker [tag]`
  const ref = args.find((a) => a.startsWith("--ref="))?.slice("--ref=".length) || currentBranch();

  const runArgs = ["workflow", "run", "docker-images.yml", "--ref", ref];
  if (dockerTag) runArgs.push("-f", `tag=${dockerTag}`);

  log(`Docker image publish (GHCR-only)`);
  log(`  workflow: docker-images.yml`);
  log(`  ref:      ${ref}`);
  log(`  tag:      ${dockerTag ?? "(short SHA)"}`);
  log(`  scope:    images ONLY — no git tag / GitHub release / npm / desktop; :latest untouched`);
  log(``);

  if (dryRun) {
    log(`[dry-run] gh ${runArgs.join(" ")}`);
    log(`[dry-run] nothing dispatched.`);
    return;
  }

  if (spawnSync("gh", ["--version"], { encoding: "utf8" }).status !== 0) {
    console.error(
      `Refusing: the \`gh\` CLI is required for \`release docker\`. Install it + \`gh auth login\`,\n` +
        `or trigger it in the UI: Actions → "Docker images" → Run workflow.`,
    );
    process.exit(1);
  }

  const res = spawnSync("gh", runArgs, { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) {
    console.error(
      `\ngh workflow run failed. Most common cause: docker-images.yml isn't on the repo's\n` +
        `DEFAULT branch yet — workflow_dispatch only works once the workflow file is on it.\n` +
        `Push the workflow to the default branch, then retry.`,
    );
    process.exit(res.status ?? 1);
  }
  log(`✓ dispatched docker-images.yml (${ref})`);

  watchDispatch();

  const or = ghOwnerRepo();
  const shown = dockerTag ?? "<short-sha>";
  log(``);
  log(`Verify when green:`);
  if (or) {
    log(`  docker manifest inspect ghcr.io/${or.owner}/openship-edge:${shown}   # amd64 + arm64`);
    log(`  docker pull ghcr.io/${or.owner}/openship-api:${shown}`);
    log(`  Packages: https://github.com/orgs/${or.owner}/packages?repo_name=${or.repo}`);
  }
}

/** Poll for + stream the just-dispatched docker-images run (newest dispatch run). */
function watchDispatch(): void {
  if (spawnSync("gh", ["--version"], { encoding: "utf8" }).status !== 0) return;
  log(`Waiting for the run to register on GitHub…`);
  let runId = "";
  for (let i = 0; i < 15 && !runId; i++) {
    Bun.sleepSync(4000);
    const out = spawnSync(
      "gh",
      ["run", "list", "--workflow", "docker-images.yml", "--event", "workflow_dispatch",
        "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (out.status === 0) {
      const id = (out.stdout ?? "").trim();
      if (id && id !== "null") runId = id;
    }
  }
  if (!runId) {
    log(`Couldn't locate the run automatically — check: gh run list --workflow docker-images.yml`);
    return;
  }
  log(``);
  log(`▼ live build status (Ctrl-C to stop watching — the build keeps running):`);
  log(``);
  spawnSync("gh", ["run", "watch", runId, "--interval", "6"], { cwd: ROOT, stdio: "inherit" });
}

function preflight(): void {
  // 1. Clean working tree
  const status = git("status", "--porcelain", { capture: true }).trim();
  if (status) {
    console.error(
      `Refusing: working tree is dirty. Commit or stash first.\n${status}`,
    );
    process.exit(1);
  }

  // 2. On main
  const branch = currentBranch();
  if (branch !== "main" && !forceBranch) {
    console.error(
      `Refusing: current branch is "${branch}", not "main". ` +
        `Pass --force-branch to release from a different branch.`,
    );
    process.exit(1);
  }

  // 3. Up-to-date with origin (refuse if behind — would push a stale tag)
  git("fetch", "origin", branch);
  const behind = git("rev-list", "--count", `HEAD..origin/${branch}`, { capture: true }).trim();
  if (behind !== "0") {
    console.error(
      `Refusing: local "${branch}" is ${behind} commit(s) behind origin. Pull first.`,
    );
    process.exit(1);
  }
}

function currentBranch(): string {
  return git("rev-parse", "--abbrev-ref", "HEAD", { capture: true }).trim();
}

function readVersion(pkgPath: string): string {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  if (!pkg.version) {
    console.error(`Refusing: ${pkgPath} has no "version" field.`);
    process.exit(1);
  }
  return pkg.version;
}

function writeVersion(pkgPath: string, next: string): void {
  const raw = readFileSync(pkgPath, "utf8");
  const re = /("version"\s*:\s*")[^"]+(")/;
  // Error only if the field is genuinely absent — NOT when it's already at the
  // target value (a no-op, common when syncing a drifted package.json).
  if (!re.test(raw)) {
    console.error(`Refusing: could not locate version field in ${pkgPath}.`);
    process.exit(1);
  }
  // Preserve formatting + trailing newline. Surgical replacement of the
  // version field rather than full re-serialization avoids reformatting
  // the whole file (which would create noisy diffs).
  const replaced = raw.replace(re, (_, a, b) => `${a}${next}${b}`);
  if (replaced !== raw) writeFileSync(pkgPath, replaced);
}

interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** e.g. "rc.1", "beta.3" — undefined when stable. */
  prerelease?: string;
}

function parseSemver(v: string): SemverParts {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) {
    console.error(`Refusing: "${v}" is not a parseable semver.`);
    process.exit(1);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  };
}

function formatSemver(p: SemverParts): string {
  const base = `${p.major}.${p.minor}.${p.patch}`;
  return p.prerelease ? `${base}-${p.prerelease}` : base;
}

function computeNext(current: string, bump: { kind: BumpKind; literal?: string }): string {
  if (bump.kind === "current") return current;
  if (bump.kind === "literal") return bump.literal!;
  const parsed = parseSemver(current);
  switch (bump.kind) {
    case "patch":
      return formatSemver({ major: parsed.major, minor: parsed.minor, patch: parsed.patch + (parsed.prerelease ? 0 : 1) });
    case "minor":
      return formatSemver({ major: parsed.major, minor: parsed.minor + 1, patch: 0 });
    case "major":
      return formatSemver({ major: parsed.major + 1, minor: 0, patch: 0 });
    case "rc": {
      // rc → next rc OR rc → stable promotion
      if (parsed.prerelease) {
        const rcMatch = parsed.prerelease.match(/^rc\.(\d+)$/);
        if (rcMatch) {
          // currently rc.N — bump to rc.(N+1)
          return formatSemver({ ...parsed, prerelease: `rc.${Number(rcMatch[1]) + 1}` });
        }
        // some other prerelease (beta.N etc.) — bump patch + start rc.1
        return formatSemver({
          major: parsed.major,
          minor: parsed.minor,
          patch: parsed.patch + 1,
          prerelease: "rc.1",
        });
      }
      // stable → next patch rc.1
      return formatSemver({
        major: parsed.major,
        minor: parsed.minor,
        patch: parsed.patch + 1,
        prerelease: "rc.1",
      });
    }
  }
}

function git(
  ...args: [string, ...(string | { capture: true })[]]
): string;
function git(
  ...args: string[]
): string;
function git(...args: (string | { capture: true })[]): string {
  const last = args[args.length - 1];
  const capture = typeof last === "object" && last !== null && (last as { capture?: boolean }).capture === true;
  const realArgs = (capture ? args.slice(0, -1) : args) as string[];
  const result = spawnSync("git", realArgs, {
    cwd: ROOT,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error(`git ${realArgs.join(" ")} exited ${result.status}`);
    process.exit(result.status ?? 1);
  }
  return capture ? (result.stdout ?? "") : "";
}

function log(msg: string): void {
  console.log(msg);
}

interface AdvisoryEntry {
  id: string;
  severity: "critical" | "recommended";
  /** The interrupt gate clients read — always true for a published release. */
  announce: boolean;
  affects: string;
  title: string;
  message: string;
  action: { label: string; kind: "update" };
  /** Install kinds the announcement targets. Omitted = all (see --modes). */
  modes?: string[];
}

/** The advisory entry for a published release. `affects: "<version"` means
 *  everyone BELOW this version sees the banner; users on it (or newer) don't. */
function buildAdvisory(
  version: string,
  opts: { critical?: boolean; message?: string; modes?: readonly string[] },
): AdvisoryEntry {
  return {
    id: `update-${version}`,
    severity: opts.critical ? "critical" : "recommended",
    // `publish` MEANS "interrupt people about this one", so it's written as an
    // explicit key rather than left for clients to infer from severity.
    announce: true,
    affects: `<${version}`,
    title: `Update to Openship ${version}`,
    message:
      opts.message ??
      `Openship ${version} is available. See the release notes for what's new — updating is recommended.`,
    action: { label: "Update now", kind: "update" },
    // Omitted entirely when targeting everyone, so the manifest stays identical
    // to what older clients (which ignore `modes`) already understand.
    ...(opts.modes && opts.modes.length > 0 ? { modes: [...opts.modes] } : {}),
  };
}

/** Write the single announcement advisory into release-advisories.json,
 *  preserving the file's $comment gate. One active announcement at a time (the
 *  newest published version); returns any prior advisory ids it replaced. */
function writeAdvisory(
  version: string,
  opts: { critical?: boolean; message?: string; modes?: readonly string[] },
): { entry: AdvisoryEntry; replaced: string[] } {
  const raw = JSON.parse(readFileSync(ADVISORIES, "utf8")) as {
    $comment?: string;
    advisories?: Array<{ id?: string }>;
  };
  const replaced = (raw.advisories ?? []).map((a) => a.id ?? "").filter(Boolean);
  const entry = buildAdvisory(version, opts);
  const nextDoc = { ...raw, advisories: [entry] };
  writeFileSync(ADVISORIES, JSON.stringify(nextDoc, null, 2) + "\n");
  return { entry, replaced };
}

/* ─── Interactive wizard ───────────────────────────────────────────────
 *
 * Prompting only: it collects answers and hands them to `buildWizardArgs`
 * (scripts/release-args.ts) to become argv the flag path already understands.
 * null = cancelled.
 */

async function runWizard(): Promise<string[] | null> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const CANCEL = Symbol("cancel");

  /** Numbered menu. Enter takes the default; `q` cancels. */
  const pick = async <T extends string>(
    title: string,
    opts: { value: T; label: string; hint?: string }[],
    defaultIndex = 0,
  ): Promise<T | typeof CANCEL> => {
    console.log(`\n${title}`);
    opts.forEach((o, i) => {
      const mark = i === defaultIndex ? "›" : " ";
      console.log(`  ${mark} ${i + 1}. ${o.label}${o.hint ? `  ${dim(o.hint)}` : ""}`);
    });
    for (;;) {
      const raw = (await rl.question(`  choice [${defaultIndex + 1}] `)).trim().toLowerCase();
      if (raw === "q") return CANCEL;
      if (!raw) return opts[defaultIndex]!.value;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= opts.length) return opts[n - 1]!.value;
      console.log(`  ${dim(`enter 1-${opts.length}, or q to cancel`)}`);
    }
  };

  const ask = async (q: string, def = ""): Promise<string> => {
    const raw = (await rl.question(`  ${q}${def ? ` [${def}]` : ""} `)).trim();
    return raw || def;
  };

  const confirm = async (q: string, def = false): Promise<boolean> => {
    const raw = (await rl.question(`  ${q} [${def ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
    if (!raw) return def;
    return raw === "y" || raw === "yes";
  };

  try {
    const current = readVersion(API_PKG);
    const branch = currentBranch();
    console.log("");
    console.log(`  Openship release`);
    console.log(`  current version  ${current}`);
    console.log(`  branch           ${branch}${branch === "main" ? "" : dim("  (not main)")}`);
    console.log(dim(`  Enter accepts the ›default; q cancels.`));

    const mode = await pick("What do you want to release?", [
      { value: "version" as const, label: "A version", hint: "bump + tag + GitHub release + installers" },
      { value: "docker" as const, label: "Docker images only", hint: "GHCR; no tag, no release, :latest untouched" },
    ]);
    if (mode === CANCEL) return null;

    const answers: WizardAnswers = { mode, dryRun: false, forceBranch: false };

    if (mode === "docker") {
      answers.dockerTag = await ask("image tag (empty = short SHA):");
      answers.dockerRef = await ask("branch to build:", branch);
    } else {
      // Preview each bump's real target so the choice is concrete.
      const preview = (k: BumpKind) => computeNext(current, { kind: k });
      const bump = await pick(
        "Which version?",
        [
          { value: "patch" as const, label: "patch", hint: `→ ${preview("patch")}` },
          { value: "minor" as const, label: "minor", hint: `→ ${preview("minor")}` },
          { value: "major" as const, label: "major", hint: `→ ${preview("major")}` },
          { value: "rc" as const, label: "rc", hint: `→ ${preview("rc")}` },
          { value: "current" as const, label: "current, as-is", hint: `→ ${current} (no bump)` },
          { value: "custom" as const, label: "custom semver…", hint: "e.g. 0.5.0-beta.2" },
        ],
        0,
      );
      if (bump === CANCEL) return null;
      answers.bump = bump;

      if (bump === "custom") {
        for (;;) {
          const v = await ask("version:");
          if (!v) return null;
          if (/^\d+\.\d+\.\d+(-[a-z0-9]+(\.\d+)?)?$/i.test(v)) {
            answers.literal = v;
            break;
          }
          console.log(`  ${dim("not a semver string — e.g. 0.5.0 or 0.5.0-rc.1")}`);
        }
      }

      const target = bump === "custom" ? answers.literal! : computeNext(current, { kind: bump });
      const isPre = target.includes("-");

      // `publish` is refused for prereleases downstream — don't offer it.
      if (isPre) {
        console.log(`\n  ${dim(`${target} is a prerelease → announcement not available (clients only read advisories from the latest stable).`)}`);
        answers.announce = "silent";
      } else {
        const announce = await pick(
          "Announce it? (raises the in-app update banner)",
          [
            { value: "silent" as const, label: "Silent", hint: "still listed in Settings → Updates" },
            { value: "recommended" as const, label: "Announce", hint: "recommended advisory" },
            { value: "critical" as const, label: "Announce as critical", hint: "shown even if muted" },
          ],
          1,
        );
        if (announce === CANCEL) return null;
        answers.announce = announce;
        if (announce !== "silent") {
          // Audience. Most releases only matter to one kind of install — a
          // desktop installer fix is noise on a VPS, an edge/compose fix is
          // noise in the desktop app. Clients filter on this, so scoping it
          // means the people it doesn't apply to are never interrupted.
          const who = await pick(
            "Who should see it?",
            [
              { value: "all" as const, label: "All installs", hint: "desktop + self-hosted + cloud" },
              { value: "selfhosted" as const, label: "Self-hosted only", hint: "VPS: compose or bare" },
              { value: "desktop" as const, label: "Desktop app only", hint: "the Electron installer" },
              { value: "cloud" as const, label: "Cloud only", hint: "the managed SaaS" },
            ],
            0,
          );
          if (who === CANCEL) return null;
          if (who !== "all") answers.modes = [who];

          const msg = await ask("banner text (empty = default, points at release notes):");
          if (msg) answers.message = msg;
        }
      }

      // Re-releasing a tag that already exists needs --force downstream (it
      // deletes + re-pushes). Surface it here so the wizard can salvage a
      // failed release instead of dead-ending on "tag already exists".
      if (tagExists(`v${target}`)) {
        console.log(`\n  ${dim(`tag v${target} already exists — a prior release used it.`)}`);
        const doForce = await confirm(
          `Re-release v${target}? Deletes the old tag + re-pushes to fire a fresh build`,
          true,
        );
        if (!doForce) return null;
        answers.force = true;
      }
    }

    // No dry-run prompt: it's pure friction in the wizard (and defaulted to N
    // anyway). The real gate is "Run it?" below, and `--dry-run` is still there
    // on the flag path for anyone who wants the plan-only preview.
    if (branch !== "main") {
      console.log(`\n  ${dim(`You are on "${branch}", not main. A real release from here needs --force-branch.`)}`);
      answers.forceBranch = await confirm(`Release from "${branch}" anyway?`, false);
      if (!answers.forceBranch) return null;
    }

    const built = buildWizardArgs(answers);
    console.log("");
    console.log(`  Plan: bun run release ${built.join(" ")}`);
    return (await confirm("Run it?", true)) ? built : null;
  } finally {
    rl.close();
  }
}

/** Dim text when the terminal supports colour; plain otherwise. */
function dim(s: string): string {
  return process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s;
}
