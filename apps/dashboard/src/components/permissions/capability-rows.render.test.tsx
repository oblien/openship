// Static markup, no DOM: toggle state is read from aria-pressed/disabled, and the
// click logic through the pure helper each toggle calls.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { CapabilityRows, toggleCapability } from "./ResourcePicker";
import type { Permission } from "@/lib/api";

function toggles(permissions: Permission[]) {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <CapabilityRows rootType="project" permissions={permissions} onSet={() => {}} />
    </I18nProvider>,
  );
  return [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, label]) => ({
    label: label!.replace(/&amp;/g, "&"),
    on: attrs!.includes('aria-pressed="true"'),
    locked: /\sdisabled=""/.test(attrs!),
  }));
}

describe("capability toggles under a project", () => {
  it("offers each capability, all off for a grant with none", () => {
    expect(toggles([]).map((t) => t.label)).toEqual([
      "View",
      "Add & verify",
      "Delete",
      "View",
      "Trigger",
    ]);
    expect(toggles([]).some((t) => t.on || t.locked)).toBe(false);
  });

  it("shows a held capability as on and editable", () => {
    expect(toggles(["domains:delete"])[2]).toEqual({ label: "Delete", on: true, locked: false });
  });

  it("locks the capabilities the coarse level presets", () => {
    // write implies view + add for domains and view + trigger for deployments, not delete.
    expect(toggles(["read", "write"]).map((t) => [t.on, t.locked])).toEqual([
      [true, true],
      [true, true],
      [false, false],
      [true, true],
      [true, true],
    ]);
    expect(toggles(["admin"]).every((t) => t.on && t.locked)).toBe(true);
  });

  it("adds or removes exactly the clicked capability", () => {
    expect(toggleCapability([], "domains:delete")).toEqual(["domains:delete"]);
    expect(toggleCapability(["domains:read", "domains:delete"], "domains:read")).toEqual([
      "domains:delete",
    ]);
  });
});
