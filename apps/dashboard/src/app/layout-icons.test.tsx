import type { ReactNode } from "react";
import { runInNewContext } from "node:vm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOUD_ICON_BASE_URL, Icon, iconAssetUrl, outlineModern } from "@repo/ui/icons";

const mocks = vi.hoisted(() => ({
  deployment: vi.fn(),
  runtimeTarget: { selfHosted: true },
  provider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@repo/core", () => ({ runtimeTarget: mocks.runtimeTarget }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/server/session", () => ({ getDeploymentInfoOrNull: mocks.deployment }));
vi.mock("@/lib/server/product-view", () => ({ resolveRequestProductView: async () => "platform" }));
vi.mock("@/components/theme-provider", () => ({
  ThemeScript: () => null,
  ThemeProvider: mocks.provider,
}));
vi.mock("@/components/toast", () => ({ ToastProvider: mocks.provider }));
vi.mock("@/components/i18n-provider", () => ({ I18nProvider: mocks.provider }));
vi.mock("@/context/AuthContext", () => ({ AuthProvider: mocks.provider }));
vi.mock("@/context/ModalContext", () => ({ ModalProvider: mocks.provider }));
vi.mock("@/components/cloud-analytics", () => ({ CloudAnalytics: () => null }));
vi.mock("@/components/network-error-handler", () => ({ NetworkErrorHandler: () => null }));
vi.mock("@/components/desktop-chrome", () => ({ DesktopChrome: () => null }));
vi.mock("@/components/instance/DesktopInstanceLinks", () => ({ DesktopInstanceLinks: () => null }));

import RootLayout from "./layout";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.runtimeTarget.selfHosted = true;
  mocks.deployment.mockResolvedValue({ selfHosted: false, deployMode: "cloud" });
  vi.stubEnv("OPENSHIP_LOCAL_API_URL", "");
  vi.stubEnv("OPENSHIP_ICON_BASE_URL", "");
});
afterEach(() => vi.unstubAllEnvs());

async function iconSource() {
  const html = renderToStaticMarkup(await RootLayout({ children: <Icon name="arrow-right" /> }));
  return html.match(/<image[^>]*href="([^"]+)"/)?.[1];
}

describe("dashboard icon hosting", () => {
  it.each(["", "/icons", "https://custom.example/icons"])(
    "renders Cloud icons from the CDN before hydration, regardless of the self-hosted override (%s)",
    async (override) => {
      vi.stubEnv("OPENSHIP_ICON_BASE_URL", override);
      expect(await iconSource()).toBe(`${CLOUD_ICON_BASE_URL}/arrow%20-%20right-18-1663766896.png`);
    },
  );

  it.each([
    { selfHosted: true, deployMode: "docker", authMode: "cloud" },
    { selfHosted: true, deployMode: "bare" },
    { selfHosted: true, deployMode: "desktop" },
    { selfHosted: false, deployMode: "desktop" },
  ])("keeps local installations on bundled artwork: %j", async (info) => {
    mocks.deployment.mockResolvedValue(info);
    expect(await iconSource()).toBe(iconAssetUrl(outlineModern["arrow-right"]));
  });

  it("honors a custom asset host on self-hosted installations", async () => {
    mocks.deployment.mockResolvedValue({ selfHosted: true, deployMode: "docker" });
    vi.stubEnv("OPENSHIP_ICON_BASE_URL", "https://custom.example/icons/");
    expect(await iconSource()).toBe(
      iconAssetUrl(outlineModern["arrow-right"], "https://custom.example/icons"),
    );
  });

  it.each([true, false])(
    "uses the configured instance identity when the API is unavailable (self-hosted: %s)",
    async (selfHosted) => {
      mocks.deployment.mockResolvedValue(null);
      mocks.runtimeTarget.selfHosted = selfHosted;
      expect(await iconSource()).toBe(
        iconAssetUrl(outlineModern["arrow-right"], selfHosted ? undefined : CLOUD_ICON_BASE_URL),
      );
    },
  );

  it("keeps desktop's injected local API on bundled artwork even while connected to Cloud", async () => {
    vi.stubEnv("OPENSHIP_LOCAL_API_URL", "http://localhost:4999");
    expect(await iconSource()).toBe(iconAssetUrl(outlineModern["arrow-right"]));
  });
});

describe("dashboard diagnostic privacy", () => {
  it.each([
    { info: { selfHosted: false, deployMode: "docker" }, localApi: "", expected: true },
    {
      info: { selfHosted: true, deployMode: "docker", authMode: "cloud" },
      localApi: "",
      expected: false,
    },
    { info: { selfHosted: true, deployMode: "bare" }, localApi: "", expected: false },
    { info: { selfHosted: false, deployMode: "desktop" }, localApi: "", expected: false },
    {
      info: { selfHosted: false, deployMode: "docker" },
      localApi: "http://localhost:4999",
      expected: false,
    },
    { info: null, localApi: "", expected: false },
  ])(
    "only enables collection for a positively identified Cloud dashboard: %j",
    async ({ info, localApi, expected }) => {
      mocks.deployment.mockResolvedValue(info);
      mocks.runtimeTarget.selfHosted = false; // A Cloud account/target alone is insufficient.
      vi.stubEnv("OPENSHIP_LOCAL_API_URL", localApi);
      const html = renderToStaticMarkup(await RootLayout({ children: null }));
      const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1]!)
        .find((script) => script.includes("__OPENSHIP_ERROR_REPORTING__"));
      expect(script).toBeTruthy();
      const window: { __OPENSHIP_ERROR_REPORTING__?: boolean } = {};
      runInNewContext(script!, { window });
      expect(window.__OPENSHIP_ERROR_REPORTING__).toBe(expected);
    },
  );
});
