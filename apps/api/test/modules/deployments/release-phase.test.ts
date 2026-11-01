import { describe, it, expect, vi } from "vitest";
import {
  MULTI_SERVICE_RELEASE_REMEDY,
  RELEASE_COMMAND_TIMEOUT_MS,
  resolveReleaseCommands,
  releasePhaseSkipReason,
  runReleasePhase,
} from "@repo/platform/engine/modules/deployments/release-phase";

/**
 * The release phase is what finally lets a deploy run `php artisan migrate
 * --force` / `rails db:migrate` — commands an app stack could not express,
 * because it declares exactly one start command and nothing else.
 *
 * Two properties carry the feature and are asserted here rather than in the
 * 2,000-line pipeline: a project that declares NOTHING must deploy exactly as it
 * did before the phase existed, and a command that fails must fail the deploy
 * BEFORE anything cuts over — so the previous version keeps serving instead of a
 * new one coming up against a schema it can't use.
 */
describe("resolveReleaseCommands", () => {
  it("is empty for null, undefined, [] and blank entries", () => {
    for (const value of [null, undefined, [], ["", "   "]]) {
      expect(resolveReleaseCommands(value)).toEqual([]);
    }
  });

  it("keeps declared order and trims", () => {
    expect(
      resolveReleaseCommands([" php artisan migrate --force ", "php artisan db:seed --force"]),
    ).toEqual(["php artisan migrate --force", "php artisan db:seed --force"]);
  });
});

describe("runReleasePhase", () => {
  // The absent-field contract: no runner is even consulted, and not one line is
  // logged — a deploy with no release commands is byte-identical to before.
  it("does nothing at all when no commands are declared", async () => {
    const run = vi.fn();
    const log = vi.fn();
    await runReleasePhase({ commands: [], run, log });
    expect(run).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("runs every command in order and logs a marker for each", async () => {
    const ran: string[] = [];
    const lines: string[] = [];
    await runReleasePhase({
      commands: ["php artisan migrate --force", "php artisan db:seed --force"],
      run: async (command) => {
        ran.push(command);
      },
      log: (message) => lines.push(message),
    });
    expect(ran).toEqual(["php artisan migrate --force", "php artisan db:seed --force"]);
    expect(lines.join("\n")).toContain("[release 1/2] $ php artisan migrate --force");
    expect(lines.join("\n")).toContain("[release 2/2] $ php artisan db:seed --force");
    expect(lines.at(-1)).toBe("Release phase complete.");
  });

  // The whole point of the phase: a failing migration must stop the deploy, and
  // must stop it BEFORE the commands after it run.
  it("fails the deploy on a non-zero exit and does not run later commands", async () => {
    const ran: string[] = [];
    const lines: Array<[string, string | undefined]> = [];
    const failing = runReleasePhase({
      commands: ["php artisan migrate --force", "php artisan db:seed --force"],
      run: async (command) => {
        ran.push(command);
        throw new Error("SQLSTATE[42S02]: Base table or view not found");
      },
      log: (message, level) => lines.push([message, level]),
    });
    await expect(failing).rejects.toThrow(/Release command failed: php artisan migrate --force/);
    // The command's own output has to reach the operator, or a failed deploy is
    // just "deploy failed" with the reason buried on a host they can't see.
    await expect(failing).rejects.toThrow(/SQLSTATE\[42S02\]/);
    expect(ran).toEqual(["php artisan migrate --force"]);
    expect(lines.some(([message, level]) => level === "error" && message.includes("[release 1/2]"))).toBe(true);
  });

  it("fails before activation when the runtime cannot run declared commands", async () => {
    const log = vi.fn();
    const message =
      "This runtime cannot run release commands. Deployment stopped before activation. " +
      "Use a supported runtime or remove the release commands.";
    await expect(runReleasePhase({
      commands: ["migrate"],
      unsupportedReason: "This runtime cannot run release commands",
      log,
    })).rejects.toThrow(message);
    expect(log).toHaveBeenCalledWith(message, "error");
  });

  // The reason build-pipeline.ts passes for a multi-service deployment.
  const MULTI_SERVICE_REASON =
    "Project release commands are not supported on multi-service deployments";

  // A service added inside the project makes it multi-service. "Use a supported
  // runtime" gives that operator nothing to do: the runtime is already Docker.
  it("points to a new single-app project when a multi-service deployment cannot run them", async () => {
    const log = vi.fn();
    const message =
      "Project release commands are not supported on multi-service deployments. " +
      "Deployment stopped before activation. " +
      "To keep the release commands, deploy the app as a new single-app Docker project. " +
      "Connect separately deployed services through Apps & Services → Add → Connect existing. " +
      "Connecting services does not convert this project back to single-app. " +
      "Otherwise remove the release commands.";
    await expect(
      runReleasePhase({
        commands: ["php artisan migrate --force"],
        unsupportedReason: MULTI_SERVICE_REASON,
        unsupportedRemedy: MULTI_SERVICE_RELEASE_REMEDY,
        log,
      }),
    ).rejects.toThrow(message);
    expect(log).toHaveBeenCalledExactlyOnceWith(message, "error");
  });

  // The multi-service caller never passes `run`, so these skips are all that
  // keeps its rollbacks and service-only actions from being refused.
  it.each([
    ["a rollback", releasePhaseSkipReason("rollback")],
    ["a service-only action", releasePhaseSkipReason("redeploy", ["db"])],
  ])("skips %s on a multi-service deployment instead of refusing it", async (_label, skip) => {
    const lines: Array<[string, string | undefined]> = [];
    await expect(
      runReleasePhase({
        commands: ["php artisan migrate --force"],
        unsupportedReason: MULTI_SERVICE_REASON,
        unsupportedRemedy: MULTI_SERVICE_RELEASE_REMEDY,
        deliberateSkipReason: skip,
        log: (message, level) => lines.push([message, level]),
      }),
    ).resolves.toBeUndefined();
    expect(lines).toEqual([
      [`${skip} — not running 1 release command: php artisan migrate --force.`, undefined],
    ]);
  });

  it("stops between commands when cancelled and preserves the cancellation reason", async () => {
    const abort = new AbortController();
    const run = vi.fn(async () => abort.abort(new Error("User cancelled")));
    await expect(runReleasePhase({
      commands: ["migrate", "seed"], run, signal: abort.signal, log: vi.fn(),
    })).rejects.toThrow("User cancelled");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("identifies rollbacks and explicit service-only actions without using image reuse", () => {
    expect(releasePhaseSkipReason("rollback")).toMatch(/Rollback/);
    expect(releasePhaseSkipReason("redeploy", ["db"])).toMatch(/selected services/);
    expect(releasePhaseSkipReason("update")).toBeUndefined();
    expect(releasePhaseSkipReason("migration")).toBeUndefined();
    expect(releasePhaseSkipReason("redeploy", [])).toBeUndefined();
  });

  // A ROLLBACK is the other kind of skip, and it is not a degraded one. Replaying
  // an older release's migrations is a no-op in the good case (the schema is
  // already ahead) and actively dangerous in the bad one, because rollback is the
  // emergency path and this phase can fail a deploy.
  it("skips deliberately without running anything, and without the run-them-by-hand advice", async () => {
    const run = vi.fn();
    const lines: Array<[string, string | undefined]> = [];
    await runReleasePhase({
      commands: ["php artisan migrate --force"],
      // A runner IS available: the point is that the decision not to run outranks
      // the ability to run, so passing `run` must not defeat the skip.
      run,
      deliberateSkipReason:
        "Rolling back to a release that was already built, so its release commands are not replayed",
      log: (message, level) => lines.push([message, level]),
    });
    expect(run).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    const [message, level] = lines[0]!;
    expect(message).toContain("Rolling back to a release that was already built");
    expect(message).toContain("php artisan migrate --force");
    expect(message).not.toMatch(/by hand/i);
    // Not a warning: this is the correct outcome of a rollback, and warning on
    // every rollback trains operators to ignore the release-phase log.
    expect(level).toBeUndefined();
  });

  // Silence still wins over both skips: a project that declares nothing gets no
  // release-phase log line at all, rollback or not.
  it("stays silent on a rollback when no commands are declared", async () => {
    const log = vi.fn();
    await runReleasePhase({
      commands: [],
      deliberateSkipReason: "Rolling back",
      log,
    });
    expect(log).not.toHaveBeenCalled();
  });

  // Bounded by construction: an unbounded release command would hold a deploy
  // open forever with the old version still serving.
  it("exports a bounded per-command budget", () => {
    expect(RELEASE_COMMAND_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RELEASE_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});
