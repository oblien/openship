import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  BLOCKING_ERROR_CODES,
  failureStatusFor,
  isBlockingErrorCode,
} from "../../../src/modules/deployments/blocking-errors";

/**
 * Two things are pinned here.
 *
 * FIRST, the promotion rule: only a failure whose cause we can name AND whose
 * resolution the operator can carry out becomes `action_required`. Everything
 * else stays `failed` — a blocker badge that offers no way forward is worse than
 * a plain failure, because it promises one.
 *
 * SECOND, a RATCHET over every guard that enumerates settled deployment
 * statuses. `deployment.status` is free text with no check constraint precisely
 * so it can be extended without a migration, and the cost of that freedom is
 * that a new value silently falls out of hand-written status lists. The failures
 * are not subtle — a missing entry hangs a 20-minute migration poll, leaves an
 * app-install wizard polling at 2s forever, or lets an outer error handler
 * overwrite a deliberately-recorded blocker.
 *
 * This scans source rather than importing, because these lists are inline
 * literals inside functions that would each need heavy mocking to reach (and two
 * of them live in Next.js page components). It follows the same spirit as
 * `i18n-parity.test.ts`: a cheap structural check on a cross-cutting invariant
 * that is otherwise enforced by nothing.
 *
 * If a guard is legitimately refactored, update the `contains` snippet here —
 * do not delete the entry.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

/** Every guard that enumerates settled statuses, and the literal it must contain. */
const SETTLED_STATUS_GUARDS: Array<{
  what: string;
  file: string;
  /** A distinctive substring proving the guard still exists (so a refactor that
   *  moved it fails loudly instead of the test vacuously passing). */
  anchor: string;
  breaks: string;
}> = [
  {
    what: "startBuild idempotency guard",
    file: "apps/api/src/modules/deployments/build.service.ts",
    anchor: '"building", "deploying", "ready", "failed", "cancelled", "action_required"',
    breaks: "POST /:id/build re-runs the build on an already-settled row",
  },
  {
    what: "markDeploymentFailedFromOutside already-settled guard",
    file: "apps/api/src/modules/deployments/build-pipeline.ts",
    anchor: '["failed", "ready", "cancelled", "action_required"]',
    breaks: "an outer throw overwrites the recorded blocker with a bare `failed`",
  },
  {
    what: "migration orchestrator TERMINAL_DEPLOY",
    file: "apps/api/src/modules/migration/migration.orchestrator.ts",
    anchor: "TERMINAL_DEPLOY",
    breaks: "waitForDeployment polls for the full VERIFY_TIMEOUT_MS (20 min)",
  },
  {
    what: "catalog app install wizard terminal poll",
    file: "apps/dashboard/src/app/(dashboard)/apps/new/[appId]/page.tsx",
    anchor: '"partial_failure", "action_required", "rejected"',
    breaks: "the install wizard polls at 2s forever and never shows the error",
  },
  {
    what: "mail install wizard terminal poll",
    file: "apps/dashboard/src/app/(dashboard)/apps/new/mail/page.tsx",
    anchor: '"partial_failure", "action_required", "rejected"',
    breaks: "the mail wizard polls at 2s forever and never shows the error",
  },
  {
    what: "deployments list status chip",
    file: "apps/dashboard/src/app/(dashboard)/deployments/utils.ts",
    anchor: 'case "action_required":',
    breaks: 'the deploy renders as a warning-toned "Pending"',
  },
  {
    what: "project status derivation",
    file: "apps/dashboard/src/utils/project-status.ts",
    anchor: "latestDeploymentBlocked",
    breaks: "the project reads Live/draft and the blocker is invisible",
  },
];

/**
 * The in-flight vocabulary, which `deployment-flags` mirrors by name. Asserted
 * against the DB's own predicate rather than a literal, because that index is the
 * real definition — if a status is ever added to it, the mirror must follow or the
 * pending-actions prompt gate silently disagrees with what "still running" means.
 */
const IN_FLIGHT_SITES = [
  "packages/db/src/schema/deployment.ts",
  "packages/db/src/repos/deployment.repo.ts",
  "apps/api/src/modules/projects/deployment-flags.ts",
];

describe("blocking error codes — the promotion rule", () => {
  it("promotes a port conflict, whose resolution is free-the-port-and-redeploy", () => {
    expect(isBlockingErrorCode("PORT_IN_USE")).toBe(true);
    expect(failureStatusFor("PORT_IN_USE")).toBe("action_required");
  });

  it("leaves a failure with no user-side resolution as a plain failure", () => {
    // Classified (so it IS recorded in error_code for diagnosis) but not
    // something the operator clears from the project page.
    expect(failureStatusFor("GITHUB_TOKEN_REQUIRED")).toBe("failed");
    expect(isBlockingErrorCode("GITHUB_TOKEN_REQUIRED")).toBe(false);
  });

  it("treats an unclassified failure as a plain failure", () => {
    expect(failureStatusFor(undefined)).toBe("failed");
    expect(failureStatusFor(null)).toBe("failed");
    expect(failureStatusFor("")).toBe("failed");
  });

  it("keeps the blocking set deliberately small", () => {
    // Not a style rule: every code in here must have a resolution the
    // pending-actions surface can actually offer. Growing this set without
    // wiring a resolution is the failure mode worth catching in review.
    expect([...BLOCKING_ERROR_CODES]).toEqual(["PORT_IN_USE"]);
  });
});

describe("the in-flight vocabulary stays one vocabulary", () => {
  it("agrees on queued/building/deploying everywhere it is spelled out", async () => {
    for (const file of IN_FLIGHT_SITES) {
      const source = readFileSync(join(REPO_ROOT, file), "utf8");
      for (const status of ["queued", "building", "deploying"]) {
        // Quote-agnostic: the schema spells these inside a raw SQL index predicate
        // (single quotes), the TS sites use double quotes.
        expect(source, `${file} lost "${status}" from its in-flight list`).toMatch(
          new RegExp(`['"]${status}['"]`),
        );
      }
    }
  });

  it("never treats a blocked deploy as in flight", async () => {
    // `action_required` is settled — the artifact is gone and clearing the blocker
    // starts a NEW deploy. If it leaked into this set, the row would hold the
    // one-in-flight-per-project slot forever and block every future deploy.
    const { IN_FLIGHT_DEPLOY_STATUSES, deploymentIsInFlight } = await import(
      "../../../src/modules/projects/deployment-flags"
    );
    expect(IN_FLIGHT_DEPLOY_STATUSES.has("action_required")).toBe(false);
    expect(deploymentIsInFlight({ status: "action_required" } as never)).toBe(false);
    expect(deploymentIsInFlight({ status: "deploying" } as never)).toBe(true);
    expect(deploymentIsInFlight(null)).toBe(false);
  });
});

describe("settled-status guards know about action_required", () => {
  for (const guard of SETTLED_STATUS_GUARDS) {
    it(`${guard.what} — else ${guard.breaks}`, () => {
      const source = readFileSync(join(REPO_ROOT, guard.file), "utf8");
      expect(source, `${guard.file}: guard moved or was rewritten`).toContain(guard.anchor);
      expect(source, `${guard.file}: guard no longer handles action_required`).toContain(
        "action_required",
      );
    });
  }
});
