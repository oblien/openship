// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { CloudResourceContext } from "@/context/CloudResourceContext";
import { ManagedServerConnectionNotice } from "./ManagedServerConnectionNotice";
import { ManagedServerActionFeedback } from "./ManagedServerActionFeedback";
import type { CloudWorkspaceSummary } from "@repo/contracts";
import type { ManagedServerActions } from "./useManagedServerActions";
const cloud = vi.hoisted(() => ({ connecting: false, loading: false, startConnect: vi.fn() }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => cloud }));
const copy = baseDictionary.servers.managedControls;
let root: Root, host: HTMLDivElement;
const render = (node: ReactNode, scope = "account-a") =>
  act(async () =>
    root.render(
      <I18nProvider>
        <CloudResourceContext.Provider value={scope}>{node}</CloudResourceContext.Provider>
      </I18nProvider>,
    ),
  );
const buttons = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].filter(
    (node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label,
  );
const button = (label: string) => {
  const found = buttons(label);
  expect(found.length, label).toBeGreaterThan(0);
  return found[0]!;
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("offers the selected server's subscription management before deletion", async () => {
  const server: CloudWorkspaceSummary = {
    id: "cws-production",
    serverId: "server-production",
    name: "Production",
    planTierId: "hobby",
    subscriptionStatus: "active",
    projectCount: 0,
    state: "running",
    resources: null,
    operation: null,
    createdAt: "2026-10-01T00:00:00Z",
  };
  const remove = vi.fn();
  const actions = {
    busy: false,
    error: null,
    preview: null,
    remove,
  } as unknown as ManagedServerActions;
  await render(
    <ManagedServerActionFeedback
      server={server}
      actions={actions}
      deleting
      onCancelDelete={vi.fn()}
    />,
  );
  const link = host.querySelector<HTMLAnchorElement>(
    'a[href="/billing/overview?workspaceId=cws-production"]',
  );
  expect(link?.textContent).toBe(baseDictionary.billing.subscription.manage);
  expect(host.textContent).toContain(baseDictionary.billing.workspaces.deleteHint);
  expect(remove).not.toHaveBeenCalled();
  await render(
    <ManagedServerActionFeedback
      server={{ ...server, id: "cws-staging", projectCount: 1 }}
      actions={actions}
      deleting
      onCancelDelete={vi.fn()}
    />,
  );
  expect(host.querySelector('a[href="/billing/overview?workspaceId=cws-production"]')).toBeNull();
  expect(host.querySelector('a[href="/billing/overview?workspaceId=cws-staging"]')).not.toBeNull();
  expect(button(baseDictionary.billing.workspaces.confirmDelete).disabled).toBe(true);
});

it("starts the existing Cloud sign-in flow and labels an account mismatch separately", async () => {
  const refresh = vi.fn();
  await render(<ManagedServerConnectionNotice issue="not_connected" refresh={refresh} />);
  expect(host.textContent).toContain(copy.cloudConnection.titles.not_connected);
  await act(async () => button(copy.cloudConnection.signIn).click());
  expect(cloud.startConnect).toHaveBeenCalledOnce();
  await render(<ManagedServerConnectionNotice issue="account_mismatch" refresh={refresh} />);
  expect(host.textContent).toContain(copy.cloudConnection.titles.account_mismatch);
  await act(async () => button(copy.retry).click());
  expect(refresh).toHaveBeenCalledOnce();
});
