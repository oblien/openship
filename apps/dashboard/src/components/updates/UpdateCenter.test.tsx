import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
import { UpdateCenter } from "./UpdateCenter";

vi.mock("./useUpdates", () => ({
  useUpdates: () => ({
    state: {
      currentVersion: "0.6.9",
      latestVersion: "0.7.0",
      updateAvailable: true,
      advisories: [],
      changelogUrl: "https://openship.io/changelog",
      latestChangelogUrl: "https://openship.io/changelog/v0-6-10",
    },
    latest: { version: "0.7.0", tag: "v0.7.0", notes: "newer notes" },
    muted: false,
    desktop: false,
    mode: "selfhosted",
    whatsNewVersion: "0.6.9",
    dismissAdvisory: () => {},
    dismissWhatsNew: () => {},
    beginUpdate: () => {},
    updatePhase: "idle",
    updateProgress: 0,
    updateError: null,
  }),
}));

describe("UpdateCenter changelog links", () => {
  it("sends the post-update toast to that version on the Openship website", () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <UpdateCenter />
      </I18nProvider>,
    );

    expect(html).toContain("Updated to Openship 0.6.9");
    expect(html).toContain('href="https://openship.io/changelog/v0-6-9"');
    expect(html).not.toContain("github.com/oblien/openship");
  });
});
