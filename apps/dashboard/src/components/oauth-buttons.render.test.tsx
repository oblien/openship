import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
import { OAuthButtons } from "./oauth-buttons";
import type { AdvertisedAuthProvider } from "@/lib/auth-providers";

/**
 * The mapping is unit-tested in lib/auth-providers.test.ts; this asserts the
 * component actually DRAWS it — the buttons the server advertised, and the
 * divider only when there is something to divide.
 *
 * Server-rendered to markup, same approach as MonitoringView.test.tsx: no jsdom,
 * no testing-library. Click behaviour isn't reachable this way, which is fine —
 * the regression this guards is a page that renders no social login on an
 * instance that has one configured (the bug being fixed), or one that renders a
 * button for a provider the server never advertised.
 */

const render = (providers: AdvertisedAuthProvider[] | undefined) =>
  renderToStaticMarkup(
    <I18nProvider>
      <OAuthButtons providers={providers} />
    </I18nProvider>,
  );

describe("OAuthButtons renders the server's list", () => {
  it("renders nothing at all — not even the divider — for an empty list", () => {
    // A default self-hosted instance. The page mounts this unconditionally now,
    // so an empty list has to produce zero markup or the login form grows a
    // stray "or" separator with nothing under it.
    expect(render([])).toBe("");
    expect(render(undefined)).toBe("");
  });

  it("renders the one configured provider on a self-hosted instance", () => {
    // The improvement: GITHUB_CLIENT_ID/SECRET set on a self-hosted box now
    // yields a real button, where the `!selfHosted` gate rendered none.
    const html = render([{ id: "github", kind: "social" }]);
    expect(html).toContain("Continue with GitHub");
    expect(html).not.toContain("Continue with Google");
    expect(html).toContain("or"); // divider is back once there IS a button
  });

  it("renders both when both are configured (the cloud case, unchanged)", () => {
    const html = render([
      { id: "github", kind: "social" },
      { id: "google", kind: "social" },
    ]);
    expect(html).toContain("Continue with GitHub");
    expect(html).toContain("Continue with Google");
  });

  it("renders no button for a provider the server did not advertise", () => {
    const html = render([{ id: "google", kind: "social" }]);
    expect(html).toContain("Continue with Google");
    expect(html).not.toContain("Continue with GitHub");
  });
});
