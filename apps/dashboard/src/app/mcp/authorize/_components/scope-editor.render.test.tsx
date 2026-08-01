// No DOM needed: renderToStaticMarkup runs no effects, so ResourcePicker's catalog
// fetch never fires and what renders is the tab strip — which is what's asserted.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { ScopeEditor } from "./ScopeEditor";
import type { PickerGrant, ResourceType } from "@/lib/api";

/**
 * Servers, mail and backups used to sit behind a "Show servers, mail and backups"
 * disclosure. It cost a click and taught nothing — the tab strip already says what
 * exists, and an empty tab is a perfectly clear "nothing here".
 *
 * The REST caveat that lived inside the disclosure is kept, but shown when it's
 * actually TRUE of the selection rather than whenever the disclosure was open.
 */

const ALL_TYPES: ResourceType[] = [
  "project",
  "github_installation",
  "github_repository",
  "server",
  "mail_server",
  "backup_destination",
];

function render(grants: PickerGrant[] = []) {
  return renderToStaticMarkup(
    <I18nProvider>
      <ScopeEditor
        selection={{ template: "custom", grants, readOnly: false }}
        availableTypes={ALL_TYPES}
        orgKey="Local User's workspace"
        onPickerChange={() => {}}
        onCreateChange={() => {}}
      />
    </I18nProvider>,
  );
}

function text(html: string) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

describe("ScopeEditor resource tabs", () => {
  it("offers every grantable type as a tab, with nothing behind a disclosure", () => {
    const out = text(render());
    // Labels from RESOURCE_TYPE_LABELS; the two github types collapse to one tab.
    for (const label of ["Projects", "GitHub", "Servers", "Mail servers", "Backup destinations"]) {
      expect(out, `${label} should be a tab`).toContain(label);
    }
  });

  it("no longer renders a show/hide toggle", () => {
    const out = text(render());
    expect(out).not.toContain("Show servers");
    expect(out).not.toContain("Hide servers");
  });

  it("hides the REST caveat until an advanced type is actually granted", () => {
    // Shown while merely browsing tabs, "These unlock no MCP tools" has no referent.
    expect(text(render())).not.toContain("unlock no MCP tools");
  });

  it("shows the REST caveat once a server/mail/backup grant exists", () => {
    // This is the part worth keeping: granting one unlocks no MCP tool, but the same
    // bearer still reaches it over REST.
    const out = text(
      render([{ resourceType: "server", resourceId: "srv_1", permissions: ["read"] }]),
    );
    expect(out).toContain("unlock no MCP tools");
  });
});
