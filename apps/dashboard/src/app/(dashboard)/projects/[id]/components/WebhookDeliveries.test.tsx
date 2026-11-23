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

it("shows the failure error details and compose changes when a delivery fails", async () => {
  const failedDelivery = {
    id: "delivery-failed",
    source: "incoming",
    event: "deploy",
    outcome: "failed",
    error: "The Compose configuration has changed. Review the latest services in Configure before deploying.",
    summary: {
      name: "Deploy hook",
      composeChanges: {
        added: ["worker"],
        changed: ["api"],
        removed: ["cache"],
      },
    },
    receivedAt: new Date().toISOString(),
  };
  const fetchPage = vi.fn().mockResolvedValue({ deliveries: [failedDelivery] });
  await act(async () =>
    root.render(
      <I18nProvider>
        <WebhookDeliveries fetchPage={fetchPage} />
      </I18nProvider>,
    ),
  );
  expect(host.textContent).toContain("Deploy hook");
  expect(host.textContent).toContain(
    "The Compose configuration has changed. Review the latest services in Configure before deploying.",
  );
  expect(host.textContent).toContain("Services: +worker, ~api, -cache");
  const details = host.querySelector("details");
  expect(details).not.toBeNull();
  expect(details?.querySelector("summary")?.textContent).toContain(
    "The Compose configuration has changed. Review the latest services in Configure before deploying.",
  );
});
