// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialProvider } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider, useModal } from "@/context/ModalContext";
import { ApiError } from "@/lib/api/client";
import type { Credential } from "@/lib/api/credentials";
import { CredentialForm } from "@/components/credentials/CredentialForm";
import DnsRecordsModal from "./DnsRecordsModal";

const h = vi.hoisted(() => ({
  connected: false,
  role: vi.fn(),
  providers: vi.fn(),
  descriptors: vi.fn(),
  credentials: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  verifyZone: vi.fn(),
  records: vi.fn(),
  previewRecords: vi.fn(),
  dnsPlan: vi.fn(),
  dnsApply: vi.fn(),
  deploy: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@/lib/api", () => ({ domainsApi: h }));
vi.mock("@/lib/api/dns", () => ({
  dnsApi: { listProviders: h.descriptors, verifyZone: h.verifyZone },
}));
vi.mock("@/lib/api/credentials", () => ({
  credentialsApi: {
    providers: h.providers,
    list: h.credentials,
    create: h.create,
    update: h.update,
  },
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { organization: { getActiveMemberRole: h.role } },
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));

const saved: Credential = {
  id: "cred-cf",
  provider: "cloudflare",
  providerLabel: "Cloudflare",
  name: "Production DNS",
  selector: null,
  publicFields: {},
  secretsMasked: { apiToken: "********" },
  status: "active",
  lastVerifiedAt: null,
  lastError: null,
  createdAt: "",
  updatedAt: "",
};
const targets = [
  { hostname: "api.example.com", domainId: "dom-api" },
  { hostname: "web.example.com", domainId: "dom-web" },
];
function plan(id: string, inSync = false) {
  return h.connected
    ? {
        status: "matched",
        provider: "cloudflare",
        zoneName: "example.com",
        records: [
          {
            name: id === "dom-api" ? "api.example.com" : "web.example.com",
            type: "A",
            action: inSync ? "in-sync" : "create",
            desired: "192.0.2.5",
          },
        ],
      }
    : { status: "none", records: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let host: HTMLDivElement;
let root: Root;
function Harness({ persisted = true }: { persisted?: boolean }) {
  const [draftName, setDraftName] = useState("My production project");
  const { showModal, hideModal } = useModal();
  return (
    <>
      <input
        aria-label="Project name"
        value={draftName}
        onChange={(event) => setDraftName(event.target.value)}
      />
      <button
        onClick={() => {
          let id = "";
          id = showModal({
            showCloseButton: false,
            customContent: (
              <DnsRecordsModal
                targets={persisted ? targets : [{ hostname: "api.example.com" }]}
                serverId="server-selected"
                onCancel={() => hideModal(id)}
                onConfirm={() => {
                  h.deploy();
                  hideModal(id);
                }}
              />
            ),
          });
        }}
      >
        Review DNS
      </button>
    </>
  );
}
function buttons(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.textContent?.trim() === label,
  );
}
function button(label: string) {
  const found = buttons(label)[0];
  expect(found, label).toBeDefined();
  return found!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function render(persisted = true) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <ModalProvider>
          <Harness persisted={persisted} />
        </ModalProvider>
      </I18nProvider>,
    ),
  );
  await click("Review DNS");
}
async function connect() {
  await click("Connect a DNS provider");
  const token = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(token).not.toBeNull();
  await fill(token, "token-for-tests-only");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.connected = false;
  h.role.mockResolvedValue({ data: { role: "owner" } });
  h.providers.mockResolvedValue({
    data: [getCredentialProvider("docker-registry"), getCredentialProvider("cloudflare")],
  });
  h.descriptors.mockResolvedValue({
    data: [
      {
        name: "cloudflare",
        displayName: "Cloudflare",
        requiredScopes: ["Zone:Read", "DNS:Edit"],
        tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
      },
    ],
  });
  h.credentials.mockResolvedValue({ data: [] });
  h.records.mockImplementation(async (id: string) => ({
    data: {
      mode: "selfhosted",
      records: [
        {
          type: "A",
          host: id === "dom-api" ? "api" : "web",
          name: id === "dom-api" ? "api.example.com" : "web.example.com",
          value: "192.0.2.5",
        },
      ],
    },
  }));
  h.previewRecords.mockResolvedValue({
    data: {
      mode: "selfhosted",
      records: [{ type: "A", host: "api", name: "api.example.com", value: "192.0.2.5" }],
    },
  });
  h.dnsPlan.mockImplementation(async (id: string) => ({ data: plan(id) }));
  h.dnsApply.mockImplementation(async (id: string) => {
    h.dnsPlan.mockImplementation(async (next: string) => ({ data: plan(next, next === id) }));
    return {
      data: {
        provisioned: true,
        records: [{ name: "api.example.com", type: "A", outcome: "applied" }],
      },
    };
  });
  h.verifyZone.mockImplementation(async () =>
    h.connected
      ? { status: "matched", matched: true, provider: "cloudflare", zoneName: "example.com" }
      : { status: "none", matched: false },
  );
  h.create.mockImplementation(async () => {
    h.connected = true;
    return { data: saved };
  });
  h.update.mockImplementation(async () => {
    h.connected = true;
    return { data: saved };
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

describe("in-context DNS connection", () => {
  it("connects once, refreshes all domains, and applies only the chosen domain on its selected server", async () => {
    await render();
    const draft = host.querySelector<HTMLInputElement>("input")!;
    await fill(draft, "Draft survives DNS setup");
    await connect();
    expect(
      document.querySelector('a[href="https://dash.cloudflare.com/profile/api-tokens"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Zone:Read and DNS:Edit");
    expect(document.body.textContent).not.toContain("Registry host");
    await click("Add credential");
    expect(h.create).toHaveBeenCalledExactlyOnceWith({
      provider: "cloudflare",
      name: "Cloudflare · api.example.com",
      selector: null,
      values: { apiToken: "token-for-tests-only" },
    });
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(draft.value).toBe("Draft survives DNS setup");
    expect(buttons("Auto-configure DNS")).toHaveLength(2);
    expect(h.dnsPlan).toHaveBeenCalledWith("dom-api", "server-selected");
    expect(h.dnsPlan).toHaveBeenCalledWith("dom-web", "server-selected");
    expect(h.dnsApply).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
    await click("Auto-configure DNS");
    expect(h.dnsApply).toHaveBeenCalledExactlyOnceWith("dom-api", "server-selected");
    expect(document.body.textContent).toContain("All records in place");
    await click("Deploy");
    expect(h.deploy).toHaveBeenCalledOnce();
  });

  it("can connect for an unsaved domain while leaving DNS writes until the domain exists", async () => {
    await render(false);
    await connect();
    await click("Add credential");
    expect(h.previewRecords).toHaveBeenCalledWith("api.example.com", false, "server-selected");
    expect(h.verifyZone).toHaveBeenCalledWith("api.example.com");
    expect(document.body.textContent).toContain("Deploy first");
    expect(document.body.textContent).toContain("192.0.2.5");
    expect(buttons("Auto-configure DNS")).toHaveLength(0);
    expect(h.dnsPlan).not.toHaveBeenCalled();
    expect(h.dnsApply).not.toHaveBeenCalled();
  });

  it("cancels only the connection dialog and restores focus without changing the draft", async () => {
    await render();
    const trigger = button("Connect a DNS provider");
    trigger.focus();
    await connect();
    const dialogs = document.querySelectorAll('[role="dialog"]');
    await act(async () =>
      dialogs[dialogs.length - 1].dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(trigger);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.deploy).not.toHaveBeenCalled();
    expect(button("Deploy").disabled).toBe(false);
  });

  it.each(["member", "viewer"])(
    "explains the admin requirement to a %s without asking for a token",
    async (role) => {
      h.role.mockResolvedValue({ data: { role } });
      await render();
      await click("Connect a DNS provider");
      expect(document.body.textContent).toContain("An owner or admin must connect");
      expect(document.querySelector('input[type="password"]')).toBeNull();
      expect(h.credentials).not.toHaveBeenCalled();
      expect(h.create).not.toHaveBeenCalled();
    },
  );

  it("closes the connection picker before the dialog when Escape is pressed", async () => {
    h.credentials.mockResolvedValue({ data: [saved] });
    await render();
    await connect();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Connection"]')!.click(),
    );
    const menu = document.querySelector<HTMLElement>('[role="listbox"]')!;
    expect(menu).not.toBeNull();
    await act(async () =>
      menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe(
      "token-for-tests-only",
    );
  });

  it("keeps a rejected token editable and shows the API error inside the dialog", async () => {
    h.create.mockRejectedValueOnce(
      new ApiError(400, "Bad Request", {
        error: "Cloudflare rejected this token: DNS:Edit is required.",
      }),
    );
    await render();
    await connect();
    await click("Add credential");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("DNS:Edit is required");
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
      "token-for-tests-only",
    );
    expect(h.deploy).not.toHaveBeenCalled();
    await click("Add credential");
    expect(buttons("Auto-configure DNS")).toHaveLength(2);
  });

  it("rotates the rejected credential instead of creating a duplicate connection", async () => {
    h.credentials.mockResolvedValue({ data: [{ ...saved, status: "invalid" }] });
    h.dnsPlan.mockImplementation(async (id: string) => ({
      data: h.connected
        ? plan(id)
        : { status: "unauthorized", records: [], reason: "Token expired" },
    }));
    await render();
    await click("Reconnect provider");
    const token = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(token.value).toBe("");
    await fill(token, "replacement-test-token");
    await click("Save changes");
    expect(h.update).toHaveBeenCalledExactlyOnceWith("cred-cf", {
      name: "Production DNS",
      selector: null,
      values: { apiToken: "replacement-test-token" },
    });
    expect(h.create).not.toHaveBeenCalled();
    expect(buttons("Auto-configure DNS")).toHaveLength(2);
  });

  it("does not duplicate credential writes or dismiss the form while saving", async () => {
    const saving = deferred<{ data: Credential }>();
    h.create.mockReturnValue(saving.promise);
    await render();
    await connect();
    const form = document.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(h.create).toHaveBeenCalledOnce();
    expect(button("Add credential").disabled).toBe(true);
    const dialog = document.querySelectorAll('[role="dialog"]')[1];
    await act(async () =>
      dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
    await act(async () => saving.resolve({ data: saved }));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("holds the deployment action until an in-flight DNS write finishes", async () => {
    h.connected = true;
    const writing = deferred<unknown>();
    h.dnsApply.mockReturnValue(writing.promise);
    await render();
    await click("Auto-configure DNS");
    expect(button("Deploy").disabled).toBe(true);
    await click("Deploy");
    expect(h.deploy).not.toHaveBeenCalled();
    await act(async () => writing.resolve({ data: { provisioned: true, records: [] } }));
    expect(button("Deploy").disabled).toBe(false);
  });

  it("keeps a record-load retry from interrupting another domain's active DNS write", async () => {
    h.connected = true;
    h.records.mockRejectedValueOnce(new Error("Cannot determine the server address"));
    const writing = deferred<unknown>();
    h.dnsApply.mockReturnValue(writing.promise);
    await render();
    expect(h.records).toHaveBeenCalledTimes(2);
    await click("Auto-configure DNS");
    await click("Retry");
    expect(h.records).toHaveBeenCalledTimes(2);
    expect(button("Deploy").disabled).toBe(true);
    await act(async () => writing.resolve({ data: { provisioned: true, records: [] } }));
    expect(button("Deploy").disabled).toBe(false);
    await click("Retry");
    expect(h.records).toHaveBeenCalledTimes(4);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows record-loading failures with a working retry instead of an empty section", async () => {
    h.previewRecords.mockRejectedValueOnce(new Error("Cannot determine the server address"));
    await render(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Cannot determine the server address",
    );
    await click("Retry");
    expect(document.body.textContent).toContain("192.0.2.5");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("shared credential form secret handling", () => {
  it("omits blank saved secrets when editing a label", async () => {
    await act(async () =>
      root.render(
        <I18nProvider>
          <CredentialForm
            provider={getCredentialProvider("cloudflare")!}
            existing={saved}
            onCancel={() => {}}
            onSaved={() => {}}
          />
        </I18nProvider>,
      ),
    );
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    await fill(host.querySelector<HTMLInputElement>('input:not([type="password"])')!, "New label");
    await click("Save changes");
    expect(h.update).toHaveBeenCalledExactlyOnceWith(saved.id, {
      name: "New label",
      selector: null,
      values: {},
    });
  });

  it("requires re-entering the secret after changing a credential's destination", async () => {
    await act(async () =>
      root.render(
        <I18nProvider>
          <CredentialForm
            provider={getCredentialProvider("docker-registry")!}
            existing={{
              ...saved,
              provider: "docker-registry",
              selector: "ghcr.io",
              publicFields: { username: "test" },
              secretsMasked: { secret: "********" },
            }}
            onCancel={() => {}}
            onSaved={() => {}}
          />
        </I18nProvider>,
      ),
    );
    const token = host.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(token.required).toBe(false);
    const selector = [...host.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.value === "ghcr.io",
    )!;
    await fill(selector, "registry.example.com");
    expect(token.required).toBe(true);
    expect(token.placeholder).not.toContain("saved");
    expect(h.update).not.toHaveBeenCalled();
  });
});
