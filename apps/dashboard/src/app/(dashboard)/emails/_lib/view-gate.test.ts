import { describe, expect, it } from "vitest";

import { resolveMailView, type MailViewInput } from "./view-gate";

/**
 * The gate exists because `?force=wizard` shipped with two writers (the Advanced
 * tab's "Re-run setup", the engine banner's gone-engine remediation) and no
 * reader — both silently returned the operator to the admin panel. These cases
 * pin the override AND, more importantly, the two things it must never override.
 */

/** An installed, healthy mail server sitting on its admin panel. */
const INSTALLED: MailViewInput = {
  addingNew: false,
  hasServer: true,
  hasStatus: true,
  registryCompleted: true,
  isCompleted: false,
  running: false,
  hasStarted: true,
  gatesActive: false,
  hasCompletionData: false,
  forceWizard: false,
  serverCount: 1,
};

const at = (patch: Partial<MailViewInput>) => resolveMailView({ ...INSTALLED, ...patch });

describe("resolveMailView", () => {
  it("shows the admin panel for a registered mail server", () => {
    expect(at({})).toBe("admin");
  });

  it("honours ?force=wizard on an installed server — the re-run must not bounce back", () => {
    expect(at({ forceWizard: true })).toBe("setup");
  });

  it("keeps the progress view when a forced re-run lands mid-install", () => {
    // Orphaning a streaming install is worse than ignoring the param.
    expect(at({ forceWizard: true, running: true })).toBe("progress");
  });

  it("keeps a DNS/PTR hold visible even with ?force=wizard", () => {
    // The hold is the one thing waiting on a human; the form must not bury it.
    expect(at({ forceWizard: true, gatesActive: true })).toBe("progress");
  });

  it("treats a just-finished install as installed, so force still reaches setup", () => {
    expect(at({ registryCompleted: false, isCompleted: true })).toBe("admin");
    expect(at({ registryCompleted: false, isCompleted: true, forceWizard: true })).toBe("setup");
  });

  it("lists the registry when several servers exist and none is open", () => {
    expect(at({ hasServer: false, hasStatus: false, serverCount: 3 })).toBe("list");
  });

  it("shows setup for a server with no mail install at all", () => {
    expect(
      at({ registryCompleted: false, hasStarted: false, hasStatus: false }),
    ).toBe("setup");
  });

  it("shows progress for a partial install nobody forced past", () => {
    expect(at({ registryCompleted: false, hasStarted: true })).toBe("progress");
  });

  it("shows setup while adding another server, even from an installed one", () => {
    expect(at({ addingNew: true, hasStarted: false })).toBe("setup");
  });

  it("never lets a stale force param strand a server with nothing installed", () => {
    // forceWizard only suppresses the admin panel; it can't invent a view.
    expect(
      at({ forceWizard: true, registryCompleted: false, hasStarted: false, hasStatus: false }),
    ).toBe("setup");
  });
});
