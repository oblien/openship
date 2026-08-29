import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { decodeSlug } from "@/utils/repoSlug";
import { environmentErrorMessage, environmentWizardHref } from "./environment-next";

/**
 * The reported symptom: "the fucking toast doesn't show me error" — while the API
 * had been answering with a perfectly clear sentence about connecting Cloud.
 */
describe("environmentErrorMessage", () => {
  it("shows the SERVER's reason, not 'API 400: Bad Request'", () => {
    // Exactly what the create endpoint returns on a Cloud-disconnected instance.
    const err = new ApiError(400, "Bad Request", {
      success: false,
      error:
        "Connect Openship Cloud to use a free subdomain — free *.opsh.io domains route " +
        "through the Openship Cloud edge. Add a custom domain instead, or connect Cloud in Settings.",
    });
    const msg = environmentErrorMessage(err, "fallback");
    expect(msg).toContain("Connect Openship Cloud");
    // The old code rendered ApiError.message, which is this and nothing else.
    expect(msg).not.toBe("API 400: Bad Request");
    expect(msg).not.toContain("API 400");
  });

  it("falls back only when the payload carries no reason", () => {
    expect(environmentErrorMessage(new ApiError(500, "Server Error", {}), "fallback")).toBe(
      "API 500: Server Error",
    );
    expect(environmentErrorMessage("not an error", "fallback")).toBe("fallback");
  });

  it("passes a plain Error's message through", () => {
    expect(environmentErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });
});

/**
 * The other half: a new environment has nothing deployed, so it belongs in the
 * wizard rather than on a project page that offers to finish it.
 */
describe("environmentWizardHref", () => {
  /**
   * `?mode=config` is the EDIT entry: `Sidebar` reads it into `isConfigMode` and
   * swaps its finish button to "Save changes" / `saveConfigOnly: true`. Sending a
   * brand-new environment there left the user on a screen that could only save
   * and return — never deploy the environment they had just created.
   */
  it("does NOT open the wizard in save-only config mode", () => {
    const href = environmentWizardHref({ id: "proj_9", projectSlug: "site-staging" });
    expect(href).not.toContain("mode=config");
    expect(href).toBe("/deploy/cHJvamVjdDpwcm9qXzk");
  });

  it("carries the project id in the path, so the wizard hydrates saved rows", () => {
    const href = environmentWizardHref({ id: "proj_9", projectSlug: "site-staging" });
    expect(decodeSlug(href.slice("/deploy/".length))).toEqual({
      kind: "project",
      projectId: "proj_9",
    });
  });

  /**
   * The reported symptom: creating an environment from the switcher landed on
   * "Repository Not Found" for a repo that was fine, and only stopped once you
   * reloaded and navigated in some other way.
   *
   * The cause was here. `/deploy/[slug]` decodes its path segment with
   * `decodeSlug` — base64url — and this function was handing it the project's
   * human-readable slug, URL-encoded. "site-staging" is not base64, so the
   * wizard's decode returned null, it set `invalid_url`, and the page renders
   * `<ErrorState type="repo-not-found">` for every error type it has.
   */
  it("emits a segment the deploy wizard can actually decode", () => {
    const href = environmentWizardHref({ id: "proj_9", projectSlug: "site-staging" });
    // The old output. Kept literal so a regression names itself.
    expect(href).not.toBe("/deploy/site-staging?projectId=proj_9&mode=config");
    expect(href.slice("/deploy/".length)).not.toBe("site-staging");
  });

  it("decodes for environment slugs that are not base64-shaped", () => {
    // A plain slug decodes to null; a length-valid one decodes to mojibake and
    // yields a bogus {kind:"repo"}. Both were reachable, which is why the bug
    // looked intermittent across differently-named environments.
    for (const projectSlug of ["openship-staging", "my-app-dev", "a/b", "shop-preview"]) {
      const href = environmentWizardHref({ id: "proj_1", projectSlug });
      expect(decodeSlug(href.slice("/deploy/".length))).toEqual({
        kind: "project",
        projectId: "proj_1",
      });
    }
  });

  it("needs no slug at all — the id carries the route", () => {
    const href = environmentWizardHref({ id: "proj_9" });
    expect(decodeSlug(href.slice("/deploy/".length))).toEqual({
      kind: "project",
      projectId: "proj_9",
    });
  });
});
