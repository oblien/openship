import { describe, expect, it } from "vitest";
import { renderableOAuthProviders } from "./auth-providers";

/**
 * The login page used to decide which social buttons exist with `!selfHosted`,
 * which is not a fact about providers at all. It cost a self-hosted operator who
 * had configured GITHUB_CLIENT_ID/SECRET their working GitHub button, and it
 * would have drawn a dead button on any cloud deploy missing a pair.
 *
 * The server now advertises the configured providers (GET /health/env →
 * `authProviders`) and this mapping decides what to draw from it. Two failure
 * modes are worth pinning:
 *   - drawing MORE than was advertised (the old hardcoded github+google pair) —
 *     every extra button is a dead end at Better Auth's "provider not found";
 *   - drawing something the build has no label or icon for, which is how a
 *     future SSO entry would arrive at an older dashboard.
 */

describe("renderableOAuthProviders", () => {
  it("renders nothing when the server advertises nothing", () => {
    // The default self-hosted instance. Callers use this to skip the divider
    // too, so "empty" has to stay genuinely empty.
    expect(renderableOAuthProviders([])).toEqual([]);
  });

  it("renders nothing when the server is too old to advertise a list", () => {
    expect(renderableOAuthProviders(undefined)).toEqual([]);
  });

  it("renders only what was advertised — one configured provider, one button", () => {
    // THE improvement: self-hosted with GitHub creds configured. Before this
    // change the page rendered no buttons; now it renders GitHub, and still not
    // Google, which has no credentials on that instance.
    expect(renderableOAuthProviders([{ id: "github", kind: "social" }])).toEqual(["github"]);
    expect(renderableOAuthProviders([{ id: "google", kind: "social" }])).toEqual(["google"]);
  });

  it("renders both for a cloud deploy that configures both", () => {
    expect(
      renderableOAuthProviders([
        { id: "google", kind: "social" },
        { id: "github", kind: "social" },
      ]),
      // Order is the dashboard's, not the server's, so the page looks the same
      // on every instance.
    ).toEqual(["github", "google"]);
  });

  it("drops an advertised provider this build cannot label or draw", () => {
    // A newer server (the SSO work) advertising something this dashboard has no
    // icon/label for. Skipping beats an unlabeled mystery button.
    expect(
      renderableOAuthProviders([
        { id: "github", kind: "social" },
        { id: "okta-oidc", kind: "social" },
      ]),
    ).toEqual(["github"]);
  });

  it("does not render a non-social entry as a social button", () => {
    // `kind` is the forward-compatibility seam: an SSO/OIDC entry is a
    // different thing to render, so it must not fall through to the branded
    // "Continue with …" treatment just because its id happens to match.
    expect(renderableOAuthProviders([{ id: "github", kind: "sso" }])).toEqual([]);
  });
});
