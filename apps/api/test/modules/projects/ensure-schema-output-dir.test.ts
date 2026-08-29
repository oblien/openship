import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import { EnsureProjectBody } from "../../../src/modules/projects/project.schema";

/**
 * #427 — POST /projects/ensure returned 400 Bad Request when creating a project
 * from the dashboard. Root cause: the deploy wizard sends the blank default
 * `outputDirectory: ""` on every create, but the ensure body schema constrained
 * outputDirectory with the pattern `^[A-Za-z0-9._~/-]+$` whose `+` requires >= 1
 * char — so `""` failed TypeBox `Value.Check` and @hono/typebox-validator returned
 * 400 { success:false, errors:[…] } BEFORE the handler ran. Not a cloud check: a
 * cloud requirement surfaces as 403. The fix relaxes `+` -> `*` (an empty
 * outputDirectory is the build pipeline's own "serve from root / unset" value).
 */
describe("EnsureProjectBody — outputDirectory blank default (#427)", () => {
  // The mechanism, isolated: the OLD pattern rejected "", the NEW one accepts it.
  it("the `+` pattern rejected empty string; `*` accepts it", () => {
    expect(/^[A-Za-z0-9._~/-]+$/.test("")).toBe(false); // old — the bug
    expect(/^[A-Za-z0-9._~/-]*$/.test("")).toBe(true); // new — the fix
  });

  it("accepts the wizard payload with an empty outputDirectory", () => {
    const wizardPayload = {
      name: "my-app",
      framework: "nextjs",
      packageManager: "npm",
      buildCommand: "npm run build",
      installCommand: "npm install",
      outputDirectory: "", // <- the blank default the dashboard sends
      composePath: "",
      hasServer: true,
      hasBuild: true,
    };

    expect(Value.Check(EnsureProjectBody, wizardPayload)).toBe(true);
  });

  it("accepts human-readable framework display labels like 'Static Site' and 'Next.js' (#427)", () => {
    expect(Value.Check(EnsureProjectBody, { name: "my-app", framework: "Static Site" })).toBe(true);
    expect(Value.Check(EnsureProjectBody, { name: "my-app", framework: "Next.js" })).toBe(true);
  });

  it("still accepts a real outputDirectory", () => {
    expect(Value.Check(EnsureProjectBody, { name: "x", outputDirectory: "dist" })).toBe(true);
    expect(Value.Check(EnsureProjectBody, { name: "x", outputDirectory: "apps/web/.next" })).toBe(true);
  });

  it("still rejects an outputDirectory with illegal characters (char class intact)", () => {
    // `*` relaxed the length floor, NOT the character class — a space is still invalid.
    expect(Value.Check(EnsureProjectBody, { name: "x", outputDirectory: "bad dir" })).toBe(false);

    // And the 400 body the client now surfaces points at the offending field:
    const errors = [...Value.Errors(EnsureProjectBody, { name: "x", outputDirectory: "bad dir" })];
    expect(errors.some((e) => e.path === "/outputDirectory")).toBe(true);
  });

  it("still requires name (the one required field)", () => {
    expect(Value.Check(EnsureProjectBody, { outputDirectory: "" })).toBe(false);
  });
});
