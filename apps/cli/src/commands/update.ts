/**
 * `openship update` — update the globally-installed CLI (which bundles the
 * self-hosted API server) to the latest published release.
 *
 * Talks to GitHub (releases/latest), NOT the Openship API. The version gate +
 * install-command are pure functions in @repo/core (`resolveCliUpdatePlan` /
 * `cliInstallCommand`), unit-tested there. The command dispatches on how the CLI
 * was delivered (tarball / from-source / npm-package — see the branches below),
 * fetches the new bundle, then RE-EXECS the freshly-fetched binary to run the
 * service reconcile (`update --apply-only`) so the NEW compose template / service
 * unit is applied in the same command — no manual `openship up` afterwards. Running
 * the reconcile in this still-running OLD process would apply the OLD template.
 *
 *   openship update            update if a newer release exists
 *   openship update --check    report current/latest only (no install)
 *   openship update --via npm  force the package manager (npm-package installs only)
 *
 * TARBALL installs (scripts/install.sh / install.ps1, marked by
 * ~/.openship/cli-install.json) take yet another path: instead of `bun add -g`/
 * `npm i -g`, `openship update` re-downloads the verified payload tarball and
 * repoints cli/current (lib/cli-payload.ts), refreshing the Node runtime first
 * so a release that raises the Node floor self-heals. This is the default
 * `curl … | sh` distribution — Node is the runtime, never the user's global Bun.
 *
 * FROM-SOURCE installs (scripts/install-source.sh, marked by
 * ~/.openship-dev/source-install.json) take a different path: instead of
 * reinstalling an npm release, `openship update` pulls the tracked git ref and
 * rebuilds the CLI + dashboard in place — a quick update with no release in the
 * loop. `--rebuild` forces it even when already at the remote tip.
 */
import { Command, Option } from "commander";
import { spawnSync } from "node:child_process";
import { resolveCliUpdatePlan, cliInstallCommand, type CliPackageManager } from "@repo/core";
import { resolveLatestTag } from "../lib/github-releases";
import { restart as restartService, selfInvocation } from "../lib/service";
import { readInstallMethod, composeUpdate } from "../lib/compose";
import { err, info, isJsonMode, ok, printJson } from "../lib/output";
import { shortSha } from "../lib/from-source";
import { readCliInstall, writeCliInstall, type CliInstall } from "../lib/cli-install";
import { ensureCliPayload } from "../lib/cli-payload";
import { ensureNodeRuntime, writeLauncher } from "../lib/node-runtime";
import { applyOnlyArgv, isReexecChild, REEXEC_ENV } from "../lib/update-reexec";
import {
  readSourceInstall,
  rebuildFromSource,
  remoteSha,
  type SourceInstall,
} from "../lib/source-install";

declare const __CLI_VERSION__: string;

interface UpdateOpts {
  check?: boolean;
  via?: string;
  rebuild?: boolean;
  /** Internal: skip the fetch, just run the service reconcile with THIS bundle. */
  applyOnly?: boolean;
}

/**
 * Reconcile the running install onto the currently-loaded CLI bundle: regenerate
 * the compose stack (new template + .env, recreate) or restart the process
 * service. This is the SECOND phase of an update — it runs in the freshly-fetched
 * binary (see reexecApply), so the NEW template/unit is what gets applied.
 *
 * Dispatches on the stable install-method marker ONLY (readInstallMethod) — never
 * `openship up`'s planMethod/ensureDocker, so the method can't flip bare→compose
 * and Docker is never auto-installed. A bare install has no marker (null) → the
 * else branch, which is correct. No prompts: composeUpdate → composeUp skips the
 * edge preflight, and restart doesn't prompt.
 */
async function runReconcile(): Promise<boolean> {
  if (readInstallMethod() === "compose") {
    const applied = await composeUpdate();
    if (isJsonMode()) printJson({ reconciled: applied, method: "compose" });
    else if (applied) ok("Compose stack regenerated, images pulled, services recreated.");
    else err("Bringing the compose stack up failed. Re-run `openship update`, or `openship up` to retry.");
    if (!applied) process.exitCode = 1;
    return applied;
  }
  const { restarted } = restartService();
  if (isJsonMode()) printJson({ reconciled: restarted, method: "bare" });
  else if (restarted) ok("Restarted the service onto the new version.");
  else ok("Restart the server to run the new version: openship up");
  return restarted;
}

/**
 * Re-exec the freshly-fetched binary to run the reconcile (`update --apply-only`)
 * so the NEW code writes the NEW compose template / service unit — the whole point
 * of this command. Running the reconcile in THIS (still old, statically-imported)
 * process would write the OLD template, which is the "first hop needs a re-run" bug.
 *
 * Reuses selfInvocation() (service.ts) — tarball → stable launcher, npm/bun &
 * from-source → execPath + entry (overwritten/rebuilt in place). Full process.env
 * is load-bearing: OPENSHIP_HOME drives OS_DIR / install-method / .env / ports, so
 * the child MUST inherit it (a dev install lives under ~/.openship-dev).
 *
 * Loop guard: OPENSHIP_UPDATE_REEXEC=1 stops a phase-2 process re-execing a phase-3.
 * spawned=false (only on a spawn failure, e.g. ENOENT) tells the caller to fall
 * back to an in-process reconcile so the box is never left un-reconciled.
 */
function reexecApply(): { spawned: boolean; status: number | null } {
  if (isReexecChild()) return { spawned: false, status: null };
  const { runtime, args } = selfInvocation();
  const argv = applyOnlyArgv(args, isJsonMode());
  const res = spawnSync(runtime, argv, {
    stdio: "inherit",
    env: { ...process.env, [REEXEC_ENV]: "1" },
  });
  return { spawned: res.error == null, status: res.status };
}

/**
 * Quick update for a from-source install: pull the tracked ref and rebuild the
 * CLI + dashboard in place (like `bun dev`), then restart the service. No npm
 * release is involved. Compares the local checkout sha against the remote tip.
 */
async function runSourceUpdate(source: SourceInstall, opts: UpdateOpts): Promise<void> {
  const current = shortSha(source.dir);
  const remote = remoteSha(source.repo, source.ref);

  if (opts.check) {
    const behind = remote != null && remote !== current;
    if (isJsonMode()) {
      printJson({ source: true, ref: source.ref, current, remote, updateAvailable: behind });
    } else if (remote == null) {
      info(`On source ${source.ref} @ ${current} — couldn't reach ${source.repo} to compare.`);
    } else if (behind) {
      info(`Source update available on ${source.ref}: ${current} → ${remote}. Run \`openship update\`.`);
    } else {
      ok(`Up to date on source ${source.ref} (${current}).`);
    }
    return;
  }

  if (!opts.rebuild && remote != null && remote === current) {
    ok(`Already up to date on source ${source.ref} (${current}). Use --rebuild to force.`);
    return;
  }

  info(`Updating from source (${source.ref})…`);
  let sha: string;
  try {
    sha = await rebuildFromSource(source);
  } catch (e) {
    err(`Source update failed: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  // Re-exec the just-rebuilt binary so ITS code runs the reconcile (compose
  // regen / restart) — see reexecApply. Fall back to an in-process restart only
  // if the spawn itself fails, so the box is never left un-reconciled.
  info(`Rebuilt from source (${source.ref} @ ${sha}).`);
  const r = reexecApply();
  if (r.spawned) {
    process.exitCode = r.status ?? 0;
    return;
  }

  const { restarted } = restartService();
  if (isJsonMode()) {
    printJson({ updated: true, source: true, ref: source.ref, from: current, to: sha, restarted });
  } else if (restarted) {
    ok(`Restarted the service — you're on ${sha}.`);
  } else {
    ok(`Restart to run it: openship up`);
  }
}

const REINSTALL_HINT = "curl -fsSL https://get.openship.io | sh";

/**
 * Update a tarball install: re-download the verified payload for the latest tag
 * and repoint cli/current, refreshing the Node runtime + launcher first so a
 * release that raises the Node floor self-heals. Mirrors the release path's
 * check/plan/reconcile, swapping `bun add -g`/`npm i -g` for the payload fetch —
 * the CLI never touches the user's global runtime.
 */
async function runTarballUpdate(install: CliInstall, opts: UpdateOpts): Promise<void> {
  const current = __CLI_VERSION__;

  let latest: string;
  try {
    latest = (await resolveLatestTag()).replace(/^v/, "");
  } catch {
    err(`Could not reach GitHub to check for updates. Try again, or reinstall: ${REINSTALL_HINT}`);
    process.exitCode = 1;
    return;
  }

  const plan = resolveCliUpdatePlan(current, latest);

  if (opts.check) {
    if (isJsonMode()) {
      printJson({ current, latest, updateAvailable: plan.action === "install", method: "tarball" });
    } else if (plan.action === "install") {
      info(`Update available: v${current} → v${latest}. Run \`openship update\`.`);
    } else {
      ok(`Up to date (v${current}).`);
    }
    return;
  }

  if (plan.action === "up-to-date") {
    ok(`Already on the latest version (v${current}).`);
    return;
  }

  const tag = `v${latest}`;
  info(`Updating v${current} → v${latest} (verified payload)…`);

  // Refresh Node first so the new bundle lands on a runtime that satisfies it.
  // Best-effort: a satisfying system node is a no-op; a vendor failure (offline,
  // or Windows where provisioning lives in install.ps1) keeps the current
  // runtime rather than aborting an otherwise-valid CLI update.
  let runtime = install.runtime;
  try {
    runtime = (await ensureNodeRuntime((m) => info(m))).source;
  } catch (e) {
    info(`Keeping the current Node runtime (couldn't refresh it: ${(e as Error).message}).`);
  }

  try {
    await ensureCliPayload(tag);
    if (process.platform !== "win32") writeLauncher();
  } catch (e) {
    err(`Update failed: ${(e as Error).message} Reinstall: ${REINSTALL_HINT}`);
    process.exitCode = 1;
    return;
  }
  writeCliInstall({ ...install, tag, runtime });

  // Re-exec the freshly-repointed binary so ITS code runs the reconcile — the
  // NEW compose template / service unit lands in this same command. Fall back to
  // an in-process reconcile only if the spawn fails (box never left un-reconciled).
  const applyViaChild = reexecApply();
  if (applyViaChild.spawned) {
    process.exitCode = applyViaChild.status ?? 0;
    return;
  }

  // Same service reconcile as the release path: compose stack regen, or restart
  // the process service onto the freshly-repointed cli/current bundle.
  if (readInstallMethod() === "compose") {
    const applied = await composeUpdate(latest);
    if (isJsonMode()) {
      printJson({ updated: true, from: current, to: latest, method: "compose", applied });
    } else if (applied) {
      ok(`Updated to v${latest} — compose stack regenerated, images pulled, services recreated.`);
    } else {
      err(`Updated the CLI to v${latest}, but bringing the compose stack up failed. Re-run \`openship update\`, or \`openship up\` to retry.`);
      process.exitCode = 1;
    }
    return;
  }

  const { restarted } = restartService();
  if (isJsonMode()) {
    printJson({ updated: true, from: current, to: latest, method: "tarball", restarted });
  } else if (restarted) {
    ok(`Updated to v${latest} and restarted the service — you're on the new version.`);
  } else {
    ok(`Updated to v${latest}. Restart the server to run the new version: openship up`);
  }
}

/** Prefer bun (the curl installer uses `bun add -g`); fall back to npm. */
function detectPackageManager(override?: string): CliPackageManager {
  if (override === "bun" || override === "npm") return override;
  const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  return hasBun ? "bun" : "npm";
}

export const updateCommand = new Command("update")
  .description("Update the Openship CLI + bundled server to the latest release")
  .option("--check", "Only report the current + latest version; don't install")
  .option("--via <manager>", "Package manager to update with: bun | npm")
  .option("--rebuild", "From-source installs: rebuild even if already at the remote tip")
  // Internal, hidden: phase 2 of the update — reconcile the service onto THIS
  // (freshly-fetched) bundle. Set by reexecApply after the fetch; not for users.
  .addOption(new Option("--apply-only").hideHelp())
  .action(async (opts: UpdateOpts) => {
    // Phase 2: the new binary re-exec'd itself to apply its own template/unit.
    // Skip every fetch path and just reconcile.
    if (opts.applyOnly) {
      await runReconcile();
      return;
    }

    // From-source installs rebuild from git in place; tarball installs (the
    // default curl|sh distribution) re-download the verified payload. The pm
    // path below is only for genuine npm/bun global installs.
    const source = readSourceInstall();
    if (source) return runSourceUpdate(source, opts);

    const cliInstall = readCliInstall();
    if (cliInstall?.method === "tarball") return runTarballUpdate(cliInstall, opts);

    const current = __CLI_VERSION__;

    let latest: string;
    try {
      latest = (await resolveLatestTag()).replace(/^v/, "");
    } catch {
      err("Could not reach GitHub to check for updates. Try again, or reinstall manually.");
      process.exitCode = 1;
      return;
    }

    const plan = resolveCliUpdatePlan(current, latest);

    if (opts.check) {
      if (isJsonMode()) {
        printJson({ current, latest, updateAvailable: plan.action === "install" });
      } else if (plan.action === "install") {
        info(`Update available: v${current} → v${latest}. Run \`openship update\`.`);
      } else {
        ok(`Up to date (v${current}).`);
      }
      return;
    }

    if (plan.action === "up-to-date") {
      ok(`Already on the latest version (v${current}).`);
      return;
    }

    const pm = detectPackageManager(opts.via);
    const ref = `openship@${latest}`;
    const argv = pm === "bun" ? ["add", "-g", ref] : ["install", "-g", ref];

    info(`Updating v${current} → v${latest} (${cliInstallCommand(pm, latest)})...`);
    const res = spawnSync(pm, argv, { stdio: "inherit", shell: process.platform === "win32" });
    if (res.status !== 0) {
      err(`Update failed (${pm} exited ${res.status ?? "with a signal"}). Reinstall manually: ${cliInstallCommand(pm, latest)}`);
      process.exitCode = 1;
      return;
    }

    // Re-exec the just-installed binary so ITS code runs the reconcile (new
    // template / unit applied in one command). Fall back to an in-process
    // reconcile only if the spawn fails, so the box is never left un-reconciled.
    const applyViaChild = reexecApply();
    if (applyViaChild.spawned) {
      process.exitCode = applyViaChild.status ?? 0;
      return;
    }

    // Compose install → the FULL reconcile: regenerate the compose file + .env
    // from the new CLI (carrying every operator setting forward), pull the
    // new-version images, and recreate. Nothing needs to be run after this —
    // `openship up` afterwards used to be the thing that broke installs, because
    // it re-rendered .env from flags it wasn't given. Bare install → restart the
    // process service so it picks up the new bundle.
    if (readInstallMethod() === "compose") {
      const applied = await composeUpdate(latest);
      if (isJsonMode()) {
        printJson({ updated: true, from: current, to: latest, via: pm, method: "compose", applied });
      } else if (applied) {
        ok(`Updated to v${latest} — compose stack regenerated, images pulled, services recreated.`);
      } else {
        err(`Updated the CLI to v${latest}, but bringing the compose stack up failed. Re-run \`openship update\`, or \`openship up\` to retry.`);
        process.exitCode = 1;
      }
      return;
    }

    // Redeploy: restart the installed service so it picks up the new bundle.
    // No service installed (e.g. `openship up --foreground`) → tell them to
    // relaunch. The service manager (KeepAlive / Restart=always) handles the
    // brief blip while the new version boots.
    const { restarted } = restartService();

    if (isJsonMode()) {
      printJson({ updated: true, from: current, to: latest, via: pm, restarted });
    } else if (restarted) {
      ok(`Updated to v${latest} and restarted the service — you're on the new version.`);
    } else {
      ok(`Updated to v${latest}. Restart the server to run the new version: openship up`);
    }
  });
