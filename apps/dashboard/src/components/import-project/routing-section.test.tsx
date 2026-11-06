// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { RoutingConfig } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import RoutingSection from "./RoutingSection";

const saved = vi.hoisted(() => vi.fn());
vi.mock("@/context/DeploymentContext", () => ({
  useDeployment: () => {
    const [routingConfig, setRouting] = useState<RoutingConfig | null>(null);
    return {
      config: { routingConfig },
      updateConfig: (next: { routingConfig: RoutingConfig | null }) => {
        saved(next);
        setRouting(next.routingConfig);
      },
    };
  },
}));

it("offers static fallback even without detected rules and retains it after collapsing", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <I18nProvider>
          <RoutingSection />
        </I18nProvider>,
      ),
    );
    const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    expect(toggle()).not.toBeNull();
    await act(async () => toggle().click());
    const fallback = () =>
      container.querySelector<HTMLButtonElement>('[aria-label="SPA fallback"]')!;
    expect(fallback().getAttribute("aria-checked")).toBe("true");
    await act(async () => fallback().click());
    expect(saved).toHaveBeenLastCalledWith({ routingConfig: { spaFallback: false } });
    await act(async () => toggle().click());
    await act(async () => toggle().click());
    expect(fallback().getAttribute("aria-checked")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
