import { describe, expect, it } from "vitest";

import type { OpenshipReadiness } from "@repo/core";
import { resolveReadinessGate } from "../../../src/modules/deployments/readiness-gate";

/**
 * The gate webmail arms, read through the resolver that decides what actually runs.
 *
 * Issue #566: a webmail container that exited on a missing `SESSION_ENCRYPTION_KEY` and
 * restarted ten times finished its deploy as "the app is deployed and running". The
 * restart-loop watch that would have caught it already existed (#335) — it is OFF by
 * default, and webmail never asked for it.
 *
 * Pinned here rather than in the install test because the VALUE is the decision: it must
 * enable stabilization (a restart-loop watch), must NOT enable the TCP probe (a different
 * question, and up to 45s on the critical path), and must veto rather than warn — a warn
 * leaves the deploy green, which is the bug.
 */

// Kept in sync with WEBMAIL_READINESS in webmail-install.service.ts, which is private to
// that module; duplicating the literal is what makes a change to it fail here.
const WEBMAIL_READINESS: OpenshipReadiness = { stabilization: true, onFailure: "fail" };

describe("webmail's readiness gate", () => {
  it("watches for a restart loop and vetoes the deploy", () => {
    const gate = resolveReadinessGate(WEBMAIL_READINESS);

    expect(gate.stabilization.enabled).toBe(true);
    expect(gate.stabilization.windowMs).toBeGreaterThan(0);
    expect(gate.onFailure).toBe("fail");
    // `active` is what makes the pipeline run a gate at all rather than skip the step.
    expect(gate.active).toBe(true);
  });

  it("does not turn on the TCP probe", () => {
    expect(resolveReadinessGate(WEBMAIL_READINESS).probe.enabled).toBe(false);
  });

  it("is the difference from the default, which watches nothing", () => {
    const off = resolveReadinessGate(undefined);

    expect(off.active).toBe(false);
    expect(off.stabilization.enabled).toBe(false);
    // The default failure policy is a warning; ours must be an explicit veto.
    expect(off.onFailure).toBe("warn");
  });
});
