// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { WebhookDeliveries } from "./WebhookDeliveries";
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
it("shows the persisted impact explanation beside its delivery without exposing unknown reason codes", async () => {
  const delivery = {
    id: "delivery",
    source: "github",
    event: "push",
    outcome: "skipped",
    summary: {
      repo: "acme/shop",
      branch: "main",
      commit: "abcdef123456",
      reason: "unrelated-workspaces",
    },
    receivedAt: new Date().toISOString(),
  };
  const fetchPage = vi
    .fn()
    .mockResolvedValue({
      deliveries: [
        delivery,
        {
          ...delivery,
          id: "unknown",
          summary: { ...delivery.summary, reason: "internal-unknown-code" },
        },
      ],
    });
  await act(async () =>
    root.render(
      <I18nProvider>
        <WebhookDeliveries fetchPage={fetchPage} />
      </I18nProvider>,
    ),
  );
  expect(host.textContent).toContain("Only unrelated workspaces changed.");
  expect(host.textContent).toContain("acme/shop#main");
  expect(host.textContent).not.toContain("internal-unknown-code");
  expect(host.querySelectorAll("li")).toHaveLength(2);
});
