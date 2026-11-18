// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { DeployCredentialModal, type DeployCredentialModalProps } from "./DeployCredentialModal";
import { openAuthWindow } from "@/utils/authWindow";

vi.mock("@/utils/authWindow", () => ({ openAuthWindow: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({}) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

let element: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
});
afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
  vi.unstubAllGlobals();
});

async function renderModal(selfHosted: boolean, props: Partial<DeployCredentialModalProps> = {}) {
  const onChoice = vi.fn();
  await act(async () => root.render(
    <I18nProvider>
      <DeployCredentialModal
        trigger="preflight-fail"
        owner="example"
        installUrl={null}
        projectId={null}
        serverId="customer-vps"
        deployTarget="server"
        buildStrategy="server"
        selfHosted={selfHosted}
        ghCliAvailable={false}
        onChoice={onChoice}
        onDismiss={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  ));
  return onChoice;
}

function buttonWithText(text: string) {
  return [...element.querySelectorAll("button")].find(button => button.textContent?.includes(text));
}

it("opens Git settings separately when a Cloud SSH deploy needs credentials", async () => {
  const onChoice = await renderModal(false);
  expect(buttonWithText("Connect GitHub on this server")).toBeUndefined();
  expect(element.querySelector<HTMLAnchorElement>('a[href="/settings?tab=git"]')?.target).toBe("_blank");
  expect(onChoice).not.toHaveBeenCalled();
});

it("opens the GitHub App installer when Cloud supplies an installation URL", async () => {
  const navigate = vi.fn();
  vi.mocked(openAuthWindow).mockReturnValue({ blocked: false, navigate, onClose: vi.fn(), close: vi.fn() });
  const installUrl = "https://github.com/apps/example/installations/new";
  await renderModal(false, { installUrl });
  expect(buttonWithText("Connect GitHub on this server")).toBeUndefined();
  const install = buttonWithText("Install the OpenShip GitHub App");
  expect(install).toBeDefined();
  await act(async () => install!.click());
  expect(navigate).toHaveBeenCalledExactlyOnceWith(installUrl);
});

it("opens per-server credentials on a self-hosted SSH deploy", async () => {
  const onChoice = await renderModal(true);
  expect(element.querySelector('a[href="/settings?tab=git"]')).toBeNull();
  const connect = buttonWithText("Connect GitHub on this server");
  expect(connect).toBeDefined();
  await act(async () => connect!.click());
  expect(onChoice).toHaveBeenCalledExactlyOnceWith({ kind: "connect-server-github" });
});
