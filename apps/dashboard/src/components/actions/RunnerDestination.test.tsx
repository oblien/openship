// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { RunnerDestination } from "./RunnerDestination";

const h = vi.hoisted(() => ({ selfHosted: false, add: vi.fn(), runners: vi.fn(), saved: vi.fn() }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: h.selfHosted, cloudAuthUrl: "https://app.openship.io" }),
}));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => "cloud" }));
vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" }, session: { activeOrganizationId: "org" } } }),
}));
vi.mock("@/components/servers/add-server-modal", () => ({ useAddServerModal: () => h.add }));
vi.mock("@/lib/api/actions", () => ({ actionsApi: { runners: h.runners } }));
vi.mock("./ActionBudget", () => ({
  ActionBudgetDialog: ({ onClose }: { onClose: () => void }) => (
    <div role="dialog">
      <button onClick={onClose}>Close budget</button>
    </div>
  ),
}));

let host: HTMLDivElement, root: Root;
const click = async (value: string) =>
  act(async () => host.querySelector<HTMLButtonElement>(`button[value="${value}"]`)!.click());
const render = async () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <RunnerDestination
          onCancel={() => {}}
          renderForm={(server, back): ReactNode => (
            <div data-testid="form">
              {server?.name ?? "Select a server"}
              <button onClick={back}>Back</button>
            </div>
          )}
        />
      </I18nProvider>,
    ),
  );
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  h.selfHosted = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("uses an existing server without creating or purchasing a destination", async () => {
  await render();
  await click("existing");
  expect(host.textContent).toContain("Select a server");
  expect(h.add).not.toHaveBeenCalled();
  expect(h.runners).not.toHaveBeenCalled();
});
it("continues with the server returned by the shared acquisition modal", async () => {
  h.add.mockImplementation((created) => created({ id: "new-server", name: "Dedicated CI" }));
  await render();
  await click("dedicated");
  expect(host.querySelector('[data-testid="form"]')?.textContent).toContain("Dedicated CI");
  expect(h.saved).not.toHaveBeenCalled(); // A saved server is not yet a verified runner.
});
it("opens the managed runner form directly in Cloud, without purchase or temporary VM choices", async () => {
  h.selfHosted = false;
  await render();
  expect(host.querySelector('[data-testid="form"]')).not.toBeNull();
  expect(host.querySelector('button[value="existing"]')).toBeNull();
  expect(host.querySelector('button[value="dedicated"]')).toBeNull();
  expect(host.querySelector('button[value="temporary"]')).toBeNull();
  expect(h.add).not.toHaveBeenCalled();
  expect(h.runners).not.toHaveBeenCalled();
});
