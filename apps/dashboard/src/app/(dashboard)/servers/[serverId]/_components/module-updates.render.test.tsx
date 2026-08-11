// No DOM needed: renderToStaticMarkup runs no effects, and the card is pure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import type { ServerModuleStatus } from "@/lib/api/system";
import { ModuleUpdatesCard, visibleModuleRows } from "./module-updates";

function row(over: Partial<ServerModuleStatus> = {}): ServerModuleStatus {
  return {
    id: "m1",
    serverId: "s1",
    moduleName: "openresty",
    installedVersion: "1.25.3.1",
    migrationVersion: "1.0.0",
    availableVersion: "1.2.0",
    behind: false,
    latestInProgress: false,
    currentLabel: "1.0.0",
    latestLabel: "1.2.0",
    detail: null,
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function render(rows: ServerModuleStatus[]) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ModuleUpdatesCard rows={rows} busy={null} onUpdate={() => {}} />
    </I18nProvider>,
  );
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The bug: `behind` is false on every failed check (the dry run threw, the catalog
 * had no verified signature, the host channel refused), so a card filtered on
 * `behind` alone rendered nothing at all — and nothing reads as "up to date" on a
 * box whose modules were never actually compared.
 */
const NOTE = "update check failed: manifest unreadable on this host";

describe("module update rows that carry a note", () => {
  it("keeps a not-behind row that has a note, and only that one", () => {
    expect(visibleModuleRows([row({ behind: false, detail: { note: NOTE } })])).toHaveLength(1);
    // The other half of the same rule: an up-to-date row still has nothing to say,
    // so the card must not become "always visible".
    expect(visibleModuleRows([row({ behind: false, detail: { catalogAvailable: true } })])).toEqual([]);
    expect(visibleModuleRows([row({ behind: false, detail: null })])).toEqual([]);
  });

  it("renders the API's diagnosis verbatim", () => {
    expect(text(render([row({ detail: { note: NOTE } })]))).toContain(NOTE);
  });

  it("does not present a failed check as an available update", () => {
    const out = text(render([row({ behind: false, detail: { note: NOTE } })]));
    expect(out).toContain("Module update check failed");
    expect(out).not.toContain("Module updates available");
  });

  it("offers no Update button for a module it could not check", () => {
    expect(render([row({ behind: false, detail: { note: NOTE } })])).not.toContain("<button");
  });

  it("shows the note beside the Update button when a checked module is also behind", () => {
    const out = text(render([row({ behind: true, detail: { note: NOTE } })]));
    expect(out).toContain(NOTE);
    expect(out).toContain("Update");
  });

  it("counts only the behind rows in the updates header", () => {
    const out = text(
      render([
        row({ moduleName: "openresty", behind: true }),
        row({ moduleName: "certbot", behind: false, detail: { note: NOTE } }),
      ]),
    );
    expect(out).toContain("Module updates available (1)");
    expect(out).toContain(NOTE);
  });
});
