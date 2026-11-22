// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getCredentialProvider } from "@repo/core";
import { baseDictionary } from "@/i18n";
import { Connections } from "./Connections";
import { GitProviderSettings } from "./GitProviderSettings";

const h = vi.hoisted(() => ({
  providers: vi.fn(),
  list: vi.fn(),
  showToast: vi.fn(),
  replace: vi.fn(),
  search: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => h.search,
  useRouter: () => ({ replace: h.replace }),
}));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("./GitHubConnection", () => ({ GitHubConnection: () => <div>GitHub connection</div> }));
vi.mock("./GitHubSources", () => ({ GitHubSources: () => <div>GitHub App sources</div> }));
vi.mock("./CloneCredentials", () => ({ CloneCredentials: () => <div>Clone credentials</div> }));
vi.mock("@/lib/api", () => ({ credentialsApi: { providers: h.providers, list: h.list } }));
vi.mock("@/components/i18n-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n-provider")>()),
  useI18n: () => ({ t: baseDictionary, locale: "en" }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock("@/components/credentials/CredentialForm", () => ({
  CredentialForm: ({ provider }: { provider: { id: string } }) => <form aria-label={provider.id} />,
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.search = new URLSearchParams();
  h.providers.mockResolvedValue({
    data: [getCredentialProvider("docker-registry"), getCredentialProvider("gitlab")],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(patch: Record<string, unknown> = {}) {
  h.list.mockResolvedValue({
    data: [
      {
        id: "registry-a",
        provider: "docker-registry",
        name: "Production GHCR",
        selector: "ghcr.io",
        publicFields: { username: "owner" },
        secretsMasked: {},
        status: "active",
        lastVerifiedAt: "2026-10-17T10:00:00Z",
        lastError: null,
        ...patch,
      },
    ],
  });
  await act(async () => root.render(<Connections />));
}

it("shows a dated verification result instead of claiming the connection is currently working", async () => {
  await render();
  expect(host.textContent).toContain("Last check passed");
  expect(host.textContent).toContain("Last verified:");
  expect(host.textContent).toContain("2026");
  expect(host.textContent).not.toContain("Working");
});

it("does not claim an unverified saved connection passed a check", async () => {
  await render({ lastVerifiedAt: null });
  expect(host.textContent).toContain("Saved");
  expect(host.textContent).not.toContain("Last check passed");
  expect(host.textContent).not.toContain("Last verified:");
});

it("a current login rejection takes precedence over an earlier successful check", async () => {
  await render({ status: "invalid", lastError: "ghcr.io rejected these credentials." });
  expect(host.textContent).toContain("Needs attention");
  expect(host.textContent).toContain("ghcr.io rejected these credentials.");
  expect(host.textContent).not.toContain("Last check passed");
});

it("keeps general connections separate and opens the shared credential form in GitLab settings", async () => {
  await render();
  expect(host.querySelector("#docker-registry")).not.toBeNull();
  expect(host.querySelector("#gitlab")).toBeNull();

  h.search.set("provider", "gitlab");
  await act(async () => root.render(<GitProviderSettings />));
  expect(host.querySelector("#docker-registry")).toBeNull();
  const buttons = () => Array.from(host.querySelectorAll("button"));
  expect(
    buttons()
      .find((b) => b.textContent === "GitLab")
      ?.getAttribute("aria-selected"),
  ).toBe("true");
  await act(async () =>
    buttons()
      .find((b) => b.textContent === "Connect GitLab")!
      .click(),
  );
  expect(host.querySelector('form[aria-label="gitlab"]')).not.toBeNull();
  await act(async () =>
    buttons()
      .find((b) => b.textContent === "GitHub")!
      .click(),
  );
  expect(h.replace).toHaveBeenCalledWith("/settings?tab=git", { scroll: false });
});

it("opens existing GitHub controls at the original Git URL and links directly to GitLab", async () => {
  await act(async () => root.render(<GitProviderSettings />));
  expect(host.textContent).toContain("GitHub App sources");
  expect(host.textContent).toContain("Clone credentials");
  expect(h.providers).not.toHaveBeenCalled();
  const gitlab = Array.from(host.querySelectorAll("button")).find(
    (b) => b.textContent === "GitLab",
  )!;
  await act(async () => gitlab.click());
  expect(h.replace).toHaveBeenCalledWith("/settings?tab=git&provider=gitlab", { scroll: false });
});

it("keeps a GitLab verification failure visible while its management controls are collapsed", async () => {
  await render({
    provider: "gitlab", name: "Team bot", status: "invalid",
    publicFields: { authorization: "host-cli", username: "team-bot" }, lastError: "Sign in again",
  });
  h.search.set("provider", "gitlab");
  await act(async () => root.render(<GitProviderSettings />));
  const panel = host.querySelector('[role="tabpanel"]')!;
  expect(panel.textContent).toContain("Team bot");
  expect(panel.textContent).toContain("@team-bot · CLI");
  expect(panel.textContent).toContain("Sign in again");
  expect(panel.querySelector('button[title="Delete"]')).toBeNull();
  const toggle = panel.querySelector<HTMLButtonElement>('button[title="Manage connection · Team bot"]')!;
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(panel.querySelector('button[title="Delete"]')).not.toBeNull();
  await act(async () => panel.querySelector<HTMLButtonElement>('button[aria-label="Add connection"]')!.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(panel.querySelector('form[aria-label="gitlab"]')).not.toBeNull();
});
