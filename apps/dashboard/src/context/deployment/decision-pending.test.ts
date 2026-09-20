import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `decisionPending` must come from the SERVER, never from the presence of a warning.
 *
 * The inference (`?? !!warningMessage`) rested on "a warning on success means a partial failure".
 * A successful deploy also warns when its domains aren't routed yet, or are routed without a TLS
 * certificate — so a clean 5/5 deploy opened the failed-services keep/reject modal reading
 * "0 of 5 services failed" above a "Retry 0 Failed Services" button.
 */
const raw = readFileSync(new URL("./useDeploymentBuild.tsx", import.meta.url), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the success handler", () => {
  it("reads the server flag and nothing else", () => {
    expect(code).toContain("decisionPending: !!data?.decisionPending");
  });

  it("never derives it from warningMessage", () => {
    // The exact shape of the bug, and any near variant of it.
    expect(code).not.toContain("?? !!warningMessage");
    expect(code).not.toMatch(/decisionPending:[^;\n]*warningMessage/);
  });

  it("still surfaces the warning itself — the information is not the decision", () => {
    // Removing the inference must not remove the warning; the operator still needs to read it,
    // just not as a keep/reject prompt.
    expect(code).toContain("warningMessage,");
  });
});

describe("every other decisionPending read is already server-driven", () => {
  it("uses the server flag on refresh and on the inactive path too", () => {
    // These were correct before this change; pinned so the three sites can't diverge again.
    expect((code.match(/!!data\??\.decisionPending/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("forwards the REST flag through finished-deployment success hydration", () => {
    const finished = code.slice(code.indexOf('else if (status === "ready")'));
    expect(finished).toContain("decisionPending: data.decisionPending");
  });
});
