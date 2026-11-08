// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { baseDictionary } from "@/i18n";
import AddServerPage from "./page";

const h = vi.hoisted(() => ({
  push: vi.fn(),
  list: vi.fn(),
  openManaged: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/lib/api", () => ({
  systemApi: { listServers: h.list },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/hooks/useSetupStream", () => ({ useSetupStream: () => ({}) }));
vi.mock("@/components/servers/server-form", () => ({
  ServerForm: () => <label>Connected server form<input aria-label="SSH host" defaultValue="192.0.2.1" /></label>,
}));
vi.mock("@/components/servers/add-server-modal", () => ({
  useAddServerModal: (options: { initialMode: string }) => {
    expect(options.initialMode).toBe("managed");
    return h.openManaged;
  },
}));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.list.mockResolvedValue([]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(selfHosted: boolean) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <PlatformProvider selfHosted={selfHosted}>
          <AddServerPage />
        </PlatformProvider>
      </I18nProvider>,
    ),
  );
}
it.each([false, true])("opens managed plans from one compact action while retaining the connection form (selfHosted=%s)", async (selfHosted) => {
  await render(selfHosted);
  expect(host.textContent).toContain("Connected server form");
  const input = host.querySelector<HTMLInputElement>('input[aria-label="SSH host"]')!;
  input.value = "192.0.2.42";
  const actions = [...host.querySelectorAll("button")].filter(button =>
    button.textContent?.includes(baseDictionary.servers.acquire.managed.label),
  );
  expect(actions).toHaveLength(1);
  expect(host.textContent).not.toContain(baseDictionary.servers.acquire.connected.description);
  await act(async () => actions[0]!.click());
  expect(h.openManaged).toHaveBeenCalledOnce();
  expect(h.push).not.toHaveBeenCalled();
  expect(host.querySelector('input[aria-label="SSH host"]')).toBe(input);
  expect(input.value).toBe("192.0.2.42");
});
