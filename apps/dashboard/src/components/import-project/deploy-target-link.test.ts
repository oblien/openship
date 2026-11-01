import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DeployTargetValue } from "./DeployTargetValue";

vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));

describe("deployment target links", () => {
  it("opens the selected server and keeps its display name", () => {
    const html = renderToStaticMarkup(
      createElement(DeployTargetValue, {
        config: { deployTarget: "server", serverId: "server-a", serverName: "Production" },
      }),
    );
    expect(html).toContain('href="/servers/server-a"');
    expect(html).toContain("Production");
  });

  it.each([
    ["cloud", baseDictionary.importProject.deploymentProcessing.targetOpenshipCloud],
    ["local", baseDictionary.importProject.deploymentProcessing.targetLocal],
  ])(
    "does not link a %s target even if an old server id remains in the configuration",
    (deployTarget, label) => {
      const html = renderToStaticMarkup(
        createElement(DeployTargetValue, {
          config: { deployTarget, serverId: "server-a" },
        }),
      );
      expect(html).not.toContain("href=");
      expect(html).toContain(label);
    },
  );

  it("shows an unlinked server label when its id is unavailable", () => {
    const html = renderToStaticMarkup(
      createElement(DeployTargetValue, {
        config: { deployTarget: "server" },
        className: "truncate",
      }),
    );
    expect(html).toBe(
      `<span class="truncate">${baseDictionary.importProject.deploymentProcessing.targetServer}</span>`,
    );
  });
});
