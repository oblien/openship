// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { baseDictionary as en } from "@/i18n";
import { RoutingUnsyncedCallout } from "./RoutingUnsyncedCallout";

const settings = vi.hoisted(() => ({
  projectData: { routingUnsynced: true, awaitingDecision: false, routingWarning: "" },
}));
vi.mock("@/context/ProjectSettingsContext", () => ({ useProjectSettings: () => settings }));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: en }) }));

beforeEach(() => {
  settings.projectData = { routingUnsynced: true, awaitingDecision: false, routingWarning: "" };
});

const render = () => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    createElement(RoutingUnsyncedCallout, { onRetry: vi.fn() }),
  );
  return host.textContent;
};

describe("the banner prefers the server's own reason", () => {
  it("renders the actual routing or certificate failure", () => {
    settings.projectData.routingWarning = "api.example.com: HTTP challenge returned 404";
    expect(render()).toContain(settings.projectData.routingWarning);
    expect(render()).not.toContain(en.projects.routingRetry.description);
  });

  it("uses the generic explanation only when no server reason is available", () => {
    expect(render()).toContain(en.projects.routingRetry.description);
  });

  it("stays hidden after repair or while a release decision is pending", () => {
    settings.projectData.routingUnsynced = false;
    expect(render()).toBe("");
    settings.projectData.routingUnsynced = true;
    settings.projectData.awaitingDecision = true;
    expect(render()).toBe("");
  });
});

describe("the fallback copy names no single cause", () => {
  const r = en.projects.routingRetry as Record<string, string>;

  it("does not claim a free .opsh.io domain", () => {
    for (const [k, v] of Object.entries(r)) {
      expect(v, `routingRetry.${k}`).not.toMatch(/opsh\.io/i);
      expect(v, `routingRetry.${k}`).not.toMatch(/free domain|free \.?opsh/i);
    }
  });

  it("does not send a self-hosted operator to Openship Cloud", () => {
    // The old description did exactly that, for a project that may never touch the cloud.
    expect(r.description).not.toMatch(/Openship Cloud/i);
  });

  it("still offers a remedy", () => {
    expect(r.description).toMatch(/DNS|edge|Retry/i);
  });
});
