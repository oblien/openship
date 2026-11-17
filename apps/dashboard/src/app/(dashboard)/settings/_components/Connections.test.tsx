// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getCredentialProvider } from "@repo/core";
import { baseDictionary } from "@/i18n";
import { Connections } from "./Connections";

const h = vi.hoisted(() => ({ providers: vi.fn(), list: vi.fn(), showToast: vi.fn() }));
vi.mock("@/lib/api", () => ({ credentialsApi: { providers: h.providers, list: h.list } }));
vi.mock("@/components/i18n-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/i18n-provider")>()),
  useI18n: () => ({ t: baseDictionary, locale: "en" }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.showToast }) }));
vi.mock("@/components/credentials/CredentialForm", () => ({ CredentialForm: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.providers.mockResolvedValue({ data: [getCredentialProvider("docker-registry")] });
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
