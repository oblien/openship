// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import DeployMailPage from "./page";
import { ApiError } from "@/lib/api/client";

const h = vi.hoisted(() => ({
  status: vi.fn(),
  deploy: vi.fn(),
  push: vi.fn(),
  toast: vi.fn(),
  ready: true,
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("serverId=mail-server"),
  useRouter: () => ({ push: h.push }),
}));
vi.mock("@/lib/api", () => ({
  mailApi: { getStatus: h.status, webmail: { deployAsProject: h.deploy } },
}));
vi.mock("@/components/i18n-provider", () => ({ useI18n: () => ({ t: baseDictionary }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("@/components/ui/PageContainer", () => ({
  PageContainer: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
// Keep the real AppDestinationPicker mapping, and substitute only inventory UI.
// A Cloud selection supplies the local execution ID produced by ServerSelector's
// shared connect flow, not a provider workspace ID or an invented Cloud option.
vi.mock("@/components/shared/ServerSelector", () => ({
  default: ({
    value,
    onSelect,
    onReadyChange,
    disabled,
  }: {
    value?: string;
    disabled?: boolean;
    onReadyChange?: (ready: boolean) => void;
    onSelect: (server: unknown) => void;
  }) => {
    useEffect(() => onReadyChange?.(h.ready), [onReadyChange, h.ready]);
    return (
      <section>
        <output data-testid="destination">{value}</output>
        <button
          disabled={disabled}
          onClick={() =>
            onSelect({
              id: "linked-managed-server",
              name: "Cloud production",
              raw: { managed: { id: "linked-workspace" } },
            })
          }
        >
          Select Cloud production
        </button>
      </section>
    );
  },
}));

let root: Root;
let container: HTMLDivElement;
const copy = baseDictionary.deploy.mail;
const saved = {
  domain: "example.com",
  installed: true,
  webmail: {
    installed: true,
    hostname: "inbox.example.com",
    serverId: "saved-managed-server",
    workspaceId: "saved-workspace",
    legacy: false,
  },
};
const render = async () => {
  await act(async () => root.render(<DeployMailPage />));
};
function button(label: string) {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
const click = async (label: string) => {
  await act(async () => button(label).click());
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.ready = true;
  h.status.mockResolvedValue(saved);
  h.deploy.mockResolvedValue({ deploymentId: "webmail-deployment", projectId: "webmail-project" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mail-backed webmail deployment", () => {
  it("preserves a saved managed destination and hostname on redeploy", async () => {
    await render();
    expect(container.querySelector('[data-testid="destination"]')?.textContent).toBe(
      "saved-managed-server",
    );
    expect(container.querySelector("input")?.value).toBe("inbox.example.com");
    await click(copy.deployButton);
    expect(h.deploy).toHaveBeenCalledWith({
      mailServerId: "mail-server",
      hostname: "inbox.example.com",
      target: { kind: "cloud", serverId: "saved-managed-server" },
      replaceLegacy: false,
    });
    expect(h.push).toHaveBeenCalledWith("/build/webmail-deployment");
  });

  it("passes the selected managed server ID and keeps duplicate submissions blocked until handoff", async () => {
    let finish!: (value: unknown) => void;
    h.deploy.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await click("Select Cloud production");
    await act(async () => {
      button(copy.deployButton).click();
      button(copy.deployButton).click();
    });
    expect(h.deploy).toHaveBeenCalledOnce();
    expect(h.deploy.mock.calls[0]?.[0].target).toEqual({
      kind: "cloud",
      serverId: "linked-managed-server",
    });
    expect(button(copy.starting).disabled).toBe(true);
    expect(button("Select Cloud production").disabled).toBe(true);
    expect(h.push).not.toHaveBeenCalled();
    await act(async () => finish({ deploymentId: "webmail-deployment" }));
    expect(button(copy.starting).disabled).toBe(true);
    expect(h.push).toHaveBeenCalledOnce();
  });

  it("requires choosing the existing app before reconnecting and passes its ID without relocating it", async () => {
    h.status.mockResolvedValue({ domain: "example.com", installed: true, webmailRecoveryCandidates: [
      { projectId: "existing-webmail", name: "Webmail example.com", hostname: "mail.example.com", serverId: "mail-server" },
    ] });
    await render();
    expect(container.textContent).toContain(copy.reconnectBody);
    expect(container.textContent).toContain(copy.reconnectChoose);
    expect(button(copy.deployButton).disabled).toBe(true);
    expect(h.deploy).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    expect(button(copy.reconnectButton).disabled).toBe(false);
    expect(container.querySelector<HTMLInputElement>('input[aria-label="'+copy.domainTitle+'"]')?.disabled).toBe(true);
    expect(button("Select Cloud production").disabled).toBe(true);
    await click(copy.reconnectButton);
    expect(h.deploy).toHaveBeenCalledWith({ mailServerId: "mail-server", hostname: "mail.example.com", target: { kind: "self", serverId: "mail-server" }, replaceLegacy: false, reconnectProjectId: "existing-webmail" });
    expect(h.push).toHaveBeenCalledWith("/build/webmail-deployment");
  });

  it("lets the operator choose among multiple existing apps rather than guessing a link", async () => {
    h.status.mockResolvedValue({ domain: "example.com", webmailRecoveryCandidates: [
      { projectId: "one", name: "First app", hostname: "mail.example.com", serverId: "mail-server" },
      { projectId: "two", name: "Second app", hostname: "mail.example.com", serverId: "mail-server" },
    ] });
    await render();
    const choices = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(choices.every(choice => !choice.checked)).toBe(true);
    expect(button(copy.deployButton).disabled).toBe(true);
    await act(async () => choices[1]!.click());
    await click(copy.reconnectButton);
    expect(h.deploy.mock.calls[0]?.[0].reconnectProjectId).toBe("two");
  });

  it("refreshes a changed mail link after a rejected reconnect without starting another deployment", async () => {
    h.status.mockResolvedValueOnce({ domain: "example.com", webmailRecoveryCandidates: [
      { projectId: "existing-webmail", name: "Existing webmail", hostname: "mail.example.com", serverId: "mail-server" },
    ] });
    h.deploy.mockRejectedValueOnce(new ApiError(409, "Conflict", { code: "WEBMAIL_LINK_CHANGED", error: "Refresh status" }));
    await render();
    await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await click(copy.reconnectButton);
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(h.deploy).toHaveBeenCalledOnce();
    expect(h.push).not.toHaveBeenCalled();
    expect(container.querySelector('input[type="radio"]')).toBeNull();
    expect(container.querySelector("input")?.value).toBe("inbox.example.com");
  });

  it("defaults a new installation to its actual mail server", async () => {
    h.status.mockResolvedValue({ domain: "example.com", installed: true, webmail: null });
    await render();
    await click(copy.deployButton);
    expect(h.deploy.mock.calls[0]?.[0]).toMatchObject({
      hostname: "mail.example.com",
      target: { kind: "self", serverId: "mail-server" },
    });
  });

  it("waits for the shared destination inventory to confirm readiness", async () => {
    h.ready = false;
    await render();
    expect(button(copy.deployButton).disabled).toBe(true);
    await click(copy.deployButton);
    expect(h.deploy).not.toHaveBeenCalled();
    h.ready = true;
    await render();
    expect(button(copy.deployButton).disabled).toBe(false);
  });

  it("does not guess the saved configuration on a failed status read and allows a retry", async () => {
    h.status.mockRejectedValueOnce(new Error("Connection lost"));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
    expect(button(copy.deployButton).disabled).toBe(true);
    expect(container.querySelector('[data-testid="destination"]')).toBeNull();
    await click(baseDictionary.chrome.apiDown.retry);
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(container.querySelector("input")?.value).toBe("inbox.example.com");
    expect(button(copy.deployButton).disabled).toBe(false);
    expect(h.deploy).not.toHaveBeenCalled();
  });

  it("keeps a failed routing read empty instead of moving webmail to the mail hostname", async () => {
    h.status.mockResolvedValue({
      ...saved,
      webmail: { ...saved.webmail, hostname: "", routingUnknown: true },
    });
    await render();
    expect(container.querySelector("input")?.value).toBe("");
    expect(button(copy.deployButton).disabled).toBe(true);
  });
});
