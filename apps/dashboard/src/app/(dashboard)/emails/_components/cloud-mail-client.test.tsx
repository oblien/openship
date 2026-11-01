// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { PlatformProvider } from "@/context/PlatformContext";
import { MailConsole } from "./mail-console";
import MailWizardPage from "../../apps/new/mail/page";
import WebmailPage from "../webmail/page";
import DeployMailPage from "../../(deployment)/deploy/mail/page";

const h = vi.hoisted(() => ({
  registry: vi.fn(),
  status: vi.fn(),
  setup: vi.fn(),
  external: vi.fn(),
  managed: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  mailApi: {
    listMailServers: h.registry,
    getStatus: h.status,
    streamSetup: h.setup,
    webmail: { deployExternal: h.external, deployAsProject: h.managed },
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/emails",
  useSearchParams: () => new URLSearchParams("serverId=old-server&force=wizard"),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["Emails", MailConsole],
  ["catalog mail wizard", MailWizardPage],
  ["webmail signpost", WebmailPage],
  ["mail-backed deployment link", DeployMailPage],
] as const)(
  "%s uses the generic Cloud app installer and never local mail APIs",
  async (_name, Page) => {
    await act(async () =>
      root.render(
        <PlatformProvider selfHosted={false} deployMode="cloud" authMode="cloud">
          <I18nProvider>
            <Page />
          </I18nProvider>
        </PlatformProvider>,
      ),
    );
    expect(container.querySelector('a[href="/apps/new/webmail"]')?.textContent).toContain(
      "Connect existing mail server",
    );
    expect(container.querySelector('a[href="/apps"]')?.textContent).toContain(
      "Manage webmail apps",
    );
    expect(container.textContent).toContain("Managed email");
    expect(container.textContent).toContain("Coming soon");
    expect(container.textContent).not.toContain("Host my own mail server");
    for (const request of Object.values(h)) expect(request).not.toHaveBeenCalled();
  },
);
