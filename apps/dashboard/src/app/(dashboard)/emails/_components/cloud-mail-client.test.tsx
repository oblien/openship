// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import * as clipboard from "@/lib/clipboard";
import { PlatformProvider } from "@/context/PlatformContext";
import { ModalProvider } from "@/context/ModalContext";
import { EmailPlans } from "@/components/billing/EmailPlans";
import { MailConsole } from "./mail-console";
import { InstanceSending } from "./admin/instance-sending";
import MailWizardPage from "../../apps/new/mail/page";
import WebmailPage from "../webmail/page";
import DeployMailPage from "../../(deployment)/deploy/mail/page";

const h = vi.hoisted(() => ({
  query: "",
  catalog: vi.fn(),
  summary: vi.fn(),
  service: vi.fn(),
  order: vi.fn(),
  registry: vi.fn(),
  status: vi.fn(),
  setup: vi.fn(),
  external: vi.fn(),
  managed: vi.fn(),
  activate: vi.fn(),
  checkout: vi.fn(),
  previewChange: vi.fn(),
  confirmChange: vi.fn(),
  changeStatus: vi.fn(),
  cancelChange: vi.fn(),
  navigate: vi.fn(),
  replace: vi.fn(),
  stats: vi.fn(),
  mailboxDomains: vi.fn(),
  mailboxes: vi.fn(),
  updateMailbox: vi.fn(),
  removeMailbox: vi.fn(),
  purgeMailbox: vi.fn(),
  sendingDomains: vi.fn(),
  connectDomain: vi.fn(),
  sender: vi.fn(),
  verifySender: vi.fn(),
  testEmail: vi.fn(),
  message: vi.fn(),
  sendingKeys: vi.fn(),
  issueKey: vi.fn(),
  revokeKey: vi.fn(),
  sendingUsage: vi.fn(),
  identityUsage: vi.fn(),
  setCap: vi.fn(),
  destinations: vi.fn(),
  linked: false, startConnect: vi.fn(), relay: vi.fn(), enableApiRelay: vi.fn(), disableApiRelay: vi.fn(), apiRelay: vi.fn(), webmailKey: vi.fn(), connectWebmail: vi.fn(),
}));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({
  connected: h.linked, cloudUser: h.linked ? { organizationId: "cloud-org" } : null, startConnect: h.startConnect,
}) }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  mailAdminApi: {
    relay: { get: h.relay },
    stats: { get: h.stats }, domains: { list: h.mailboxDomains },
    mailboxes: { list: h.mailboxes, update: h.updateMailbox, softDelete: h.removeMailbox, hardDelete: h.purgeMailbox },
  },
  mailApi: {
    listMailServers: h.registry,
    getStatus: h.status,
    streamSetup: h.setup,
    webmail: { deployExternal: h.external, deployAsProject: h.managed },
  },
}));
vi.mock("@/hooks/useServerDestinations", () => ({ useServerDestinations: h.destinations }));
vi.mock("@/lib/auth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-client")>()),
  useSession: () => ({ data: { user: { id: "user-test" }, session: {} }, isPending: false }),
}));
vi.mock("@/components/billing/useCloudBilling", () => ({ useCloudPlans: h.catalog }));
vi.mock("@/lib/api/managed-mail", () => ({
  managedMailApi: {
    hostedSending: async () => ({ configured: false }), webmailKey: h.webmailKey, connect: h.connectWebmail, enableApiRelay: h.enableApiRelay, disableApiRelay: h.disableApiRelay, apiRelay: h.apiRelay,
    domains: h.sendingDomains, domain: h.connectDomain, sender: h.sender, verify: h.verifySender, keys: h.sendingKeys, usage: h.sendingUsage,
    testEmail: h.testEmail, message: h.message, issueKey: h.issueKey, revoke: h.revokeKey,
    identityUsage: h.identityUsage, setCap: h.setCap,
    summary: h.summary,
    service: h.service,
    order: h.order,
    activate: h.activate,
    checkout: h.checkout,
    previewChange: h.previewChange,
    confirmChange: h.confirmChange,
    changeStatus: h.changeStatus,
    cancelChange: h.cancelChange,
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: h.navigate, replace: h.replace, refresh: vi.fn() }),
  usePathname: () => "/emails",
  useSearchParams: () => new URLSearchParams(h.query),
}));

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  h.query = "";
  h.linked = false;
  h.relay.mockResolvedValue({ relay: null });
  h.identityUsage.mockResolvedValue({ usage: null, canEdit: true });
  h.sendingUsage.mockResolvedValue({ usedPeriod: 4, reservedPeriod: 2, policy: { period: 500 } });
  h.catalog.mockReturnValue({ loading: true });
  h.destinations.mockReturnValue({
    data: { servers: [] },
    loading: false,
    organizationId: "org-test",
  });
  h.summary.mockResolvedValue({
    plan: "included",
    service: null,
    limits: { domains: 1, mailboxes: 1, storageMB: 1024, recipients: 500 },
  });
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
] as const)("%s offers a shared mail service and retains external webmail", async (_name, Page) => {
  await act(async () =>
    root.render(
      <PlatformProvider selfHosted={false} deployMode="cloud" authMode="cloud">
        <I18nProvider>
          <Page />
        </I18nProvider>
      </PlatformProvider>,
    ),
  );
  expect(container.querySelector("h1")?.textContent).toBe("OpenShip Mail");
  expect(container.querySelector('input[aria-label="Sender domain"]')).not.toBeNull();
  expect(container.querySelector('a[href="/emails?mailView=sending"]')?.textContent).toBe("Manage sending");
  const options = container.querySelector<HTMLButtonElement>('button[aria-label="Email options"]')!;
  await act(async () => options.click());
  expect(container.textContent).toContain("Manage webmail apps");
  const connect = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Connect existing mail server",
  )!;
  await act(async () => connect.click());
  expect(h.navigate).toHaveBeenCalledWith("/emails?mailView=connect", { scroll: false });
  expect(container.textContent).toContain("Included with compute");
  expect(h.catalog).not.toHaveBeenCalled();
  expect(h.summary).toHaveBeenCalledTimes(1);
  expect(container.textContent).not.toContain("Host my own mail server");
  for (const request of [h.registry, h.status, h.setup, h.external, h.managed])
    expect(request).not.toHaveBeenCalled();
});

it("opens the shared mail overview after activation and exposes the private IMAP and webmail endpoints", async () => {
  const service = {
    id: "managed-mail-test",
    placement: "standard",
    hostname: "mail.slot.example.test",
    webmailUrl: "https://webmail.slot.example.test",
  };
  h.query = "mailView=mailboxes";
  h.activate.mockResolvedValue(service);
  h.stats.mockResolvedValue({
    inbox: { total: 20, domains: [
      { domain: "example.test", messages: 13, mailboxes: [{ username: "hello@example.test", messages: 13 }] },
      { domain: "studio.test", messages: 7, mailboxes: [{ username: "hello@studio.test", messages: 7 }] },
    ] },
    domains: { total: 2, active: 2 },
    mailboxes: { total: 2, active: 2 },
    aliases: { total: 0 },
    storageBytes: 0,
    messages: 0,
  });
  await act(async () =>
    root.render(
      <PlatformProvider selfHosted={false} deployMode="cloud" authMode="cloud">
        <I18nProvider>
          <MailConsole />
        </I18nProvider>
      </PlatformProvider>,
    ),
  );
  const activate = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Activate mailboxes",
  );
  expect(activate).toBeDefined();
  await act(async () => activate!.click());
  expect(container.textContent).toContain("IMAP 993");
  expect(container.textContent).toContain("mail.slot.example.test");
  expect(container.querySelector('a[href="https://webmail.slot.example.test"]')).not.toBeNull();
  expect(container.textContent).toContain("Mailboxes");
  expect(h.stats).toHaveBeenCalledWith(service.id, { inbox: true });
  expect(container.textContent).toContain("Inbox messages");
  expect(container.textContent).toContain("hello@example.test");
  const activity = container.querySelector('section[aria-label="Mailbox activity"]')!;
  expect(activity.querySelectorAll("header")).toHaveLength(1);
  expect(activity.querySelector("header")?.textContent).toContain("20 Inbox messages");
  const studio = activity.querySelector('li[aria-label="hello@studio.test"]')!;
  expect(studio.querySelector("dd")?.textContent).toBe("7");
  expect(studio.querySelector("h3 a")?.getAttribute("href")).toContain("domain=studio.test");
  expect(h.identityUsage).toHaveBeenCalledExactlyOnceWith("senders");
  const edit = studio.querySelector<HTMLButtonElement>(
    '[aria-label="Edit sending limit for hello@studio.test"]',
  )!;
  expect(edit.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("0");
  await act(async () => edit.click());
  const drawer = document.querySelector<HTMLElement>(
    '[role="dialog"][aria-label="Mailbox sending limit"]',
  )!;
  await act(async () =>
    drawer.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(),
  );
  const input = drawer.querySelector<HTMLInputElement>('input[type="number"]')!;
  expect(input.min).toBe("0");
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "0");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const save = () =>
    drawer
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  h.setCap.mockRejectedValueOnce(new Error("Provider unavailable"));
  await act(async () => {
    save();
  });
  expect(h.setCap).toHaveBeenLastCalledWith("senders", "hello@studio.test", 0);
  expect(drawer.querySelector('[role="alert"]')?.textContent).toContain("Provider unavailable");
  h.setCap.mockResolvedValueOnce({ success: true });
  h.summary.mockResolvedValue({
    service,
    plan: "included",
    sendingConfigured: true,
    limits: { domains: 1, mailboxes: 1, storageMB: 1024, recipients: 500 },
  });
  h.identityUsage.mockResolvedValueOnce({
    canEdit: true,
    usage: {
      data: [{ identity: "HELLO@STUDIO.TEST", monthlyCap: 0, accepted: 4, pending: 2 }],
      unattributed: { accepted: 220, pending: 0 },
      resetAt: "2026-12-01T00:00:00Z",
      monthStart: "2026-11-01T00:00:00Z",
    },
  });
  await act(async () => {
    save();
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(studio.textContent).toContain("Sending blocked");
  expect(h.summary).toHaveBeenCalledTimes(2);
  await act(async () =>
    studio
      .querySelector<HTMLButtonElement>('[aria-label="Edit sending limit for hello@studio.test"]')!
      .click(),
  );
  const savedDrawer = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(savedDrawer.textContent).toContain("4 accepted · 2 pending");
  expect(savedDrawer.textContent).toContain("220 accepted");
  await act(async () =>
    savedDrawer.querySelector<HTMLInputElement>('input[type="radio"]')!.click(),
  );
  await act(async () => {
    savedDrawer
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(h.setCap).toHaveBeenLastCalledWith("senders", "hello@studio.test", null);
  const sidebar = container.querySelector("aside")!;
  expect(sidebar.textContent).toContain("Mail server");
  const filter = sidebar.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  await act(async () => filter.click());
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
    option => option.textContent?.includes("example.test"),
  )!;
  expect(option.textContent).toContain("1 mailbox · 13 Inbox messages");
  await act(async () => option.click());
  expect(activity.querySelector("header")?.textContent).toContain("13 Inbox messages");
  expect(activity.querySelectorAll("li")).toHaveLength(1);
  expect(activity.querySelector('li[aria-label="hello@example.test"] dd')?.textContent).toBe("13");
  expect(h.stats).toHaveBeenCalledTimes(1);
  expect(h.registry).not.toHaveBeenCalled();
});

async function renderView(query = "") {
  h.query = query;
  await act(async () =>
    root.render(
      <PlatformProvider selfHosted={false} deployMode="cloud" authMode="cloud" cloudApiUrl="https://api.cloud.example.test">
        <I18nProvider>
          <ModalProvider><MailConsole /></ModalProvider>
        </I18nProvider>
      </PlatformProvider>,
    ),
  );
}

function buttonNamed(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  expect(button).toBeDefined();
  return button!;
}

it("manages a Cloud mailbox on the selected service, with a password-only update and confirmed deletion", async () => {
  const id = "managed-mail-test";
  const username = "sam@team.test";
  h.summary.mockResolvedValue({
    plan: "team",
    service: {
      id,
      placement: "standard",
      hostname: "mail.worker.test",
      webmailUrl: "https://webmail.worker.test",
    },
  });
  h.mailboxDomains.mockResolvedValue({ domains: [{ domain: "team.test" }] });
  h.mailboxes.mockResolvedValue({
    mailboxes: [{ username, domain: "team.test", name: "Sam", quotaMB: 2048, active: true }],
  });
  await renderView("tab=mailboxes");
  expect(h.mailboxes).toHaveBeenCalledWith(id, "team.test");
  const click = async (label: string) => {
    const button = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === label,
    );
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  };
  await click("Manage");
  await click("Change password");
  let form = document.querySelector("form")!;
  expect(form.textContent).toContain(username);
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  await click("Generate");
  const generated = form.querySelector<HTMLInputElement>(
    'input[autocomplete="new-password"]',
  )!.value;
  await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(h.updateMailbox).toHaveBeenCalledExactlyOnceWith(id, username, { password: generated });
  await click("Manage");
  await click("Delete");
  expect(h.removeMailbox).not.toHaveBeenCalled();
  form = document.querySelector("form")!;
  expect(form.textContent).toContain(username);
  await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  expect(h.removeMailbox).toHaveBeenCalledExactlyOnceWith(id, username);
  expect(h.purgeMailbox).not.toHaveBeenCalled();
});

it("identifies a read-only worker before offering mailbox writes", async () => {
  h.summary.mockResolvedValue({
    plan: "team",
    service: {
      id: "managed-mail-sample",
      placement: "standard",
      hostname: "mail.sample.test",
      webmailUrl: "https://webmail.sample.test",
    },
  });
  h.mailboxDomains.mockResolvedValue({ domains: [{ domain: "sample.test" }] });
  h.mailboxes.mockResolvedValue({
    readOnly: true,
    mailboxes: [
      {
        username: "sam@sample.test",
        domain: "sample.test",
        name: "Sam",
        quotaMB: 2048,
        active: true,
      },
    ],
  });
  await renderView("tab=mailboxes");
  expect(container.textContent).toContain("This mail server is read-only.");
  expect(buttonNamed("Add mailbox").disabled).toBe(true);
  await act(async () => buttonNamed("Manage").click());
  for (const label of ["Change password", "Edit", "Delete"])
    expect(buttonNamed(label).disabled).toBe(true);
  expect(h.updateMailbox).not.toHaveBeenCalled();
  expect(h.removeMailbox).not.toHaveBeenCalled();
});

it("offers access or pricing without loading checkout or VM inventory for a new organization", async () => {
  h.summary.mockResolvedValue({ plan: null, service: null, hostingAvailable: false });
  await renderView();
  expect(container.querySelector('a[href="/billing/plans?product=email"]')?.textContent).toContain(
    "View email plans",
  );
  expect(container.querySelector('a[href="/emails?mailView=connect"]')?.textContent).toContain(
    "Connect your mail server",
  );
  expect(h.catalog).not.toHaveBeenCalled();
  expect(h.destinations).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Shared hosting");
  await renderView("mailPlan=solo");
  expect(
    container.querySelector('a[href="/billing/plans?product=email&mailPlan=solo"]'),
  ).not.toBeNull();
  expect(h.checkout).not.toHaveBeenCalled();
});
it("offers instance administration before external IMAP and validates the destination", async () => {
  await renderView("mailView=connect");
  const form = container.querySelector("form")!;
  expect(form.textContent).toContain("OpenShip Mail server");
  await act(async () =>
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Enter the address");
  expect(container.querySelector('a[href="/apps/new/webmail"]')?.textContent).toContain("IMAP");
  expect(h.registry).not.toHaveBeenCalled();
});
it("opens a send-only plan on Sending and previews an inbox under Mailboxes", async () => {
  h.summary.mockResolvedValue({ plan: "solo", mailboxPlan: null, service: null });
  await renderView();
  expect(container.querySelector('input[aria-label="Sender domain"]')).not.toBeNull();
  expect(container.querySelector('a[aria-current="page"]')?.textContent).toBe("Sending");
  const mailboxes = container.querySelector<HTMLAnchorElement>('a[href="?tab=mailboxes"]')!;
  expect(mailboxes.textContent).toBe("Mailboxes");
  await renderView(mailboxes.search.slice(1));
  expect(container.querySelector('a[aria-current="page"]')?.textContent).toBe("Mailboxes");
  expect(container.querySelector('img[alt="Preview of the OpenShip Mail inbox"]')).not.toBeNull();
  expect(container.querySelector('a[href="/billing/plans?product=email&mailProduct=mailboxes"]')?.textContent).toBe("View mailbox plans");
  expect(h.mailboxes).not.toHaveBeenCalled();
  expect(h.stats).not.toHaveBeenCalled();
  expect(h.destinations).not.toHaveBeenCalled();
  expect(h.activate).not.toHaveBeenCalled();
});

it("offers activation when a sender already has mailbox coverage", async () => {
  h.summary.mockResolvedValue({ plan: "team", product: "sending", mailboxPlan: "included", service: null, hostingAvailable: true });
  await renderView("tab=mailboxes");
  expect(buttonNamed("Activate mailboxes")).toBeTruthy();
  expect(container.textContent).not.toContain("View mailbox plans");
});

it("opens the funded inbox from a dedicated-only deep link while billing is unavailable", async () => {
  h.summary.mockResolvedValue({ plan: null, service: null, billingUnavailable: true, services: [
    { id: "unpaid", placement: "dedicated", plan: "team", pendingCheckout: true },
    { id: "ready", placement: "dedicated", plan: "solo", pendingCheckout: false },
  ] });
  await renderView("mailView=sending&senderId=sender-one");
  expect(h.replace).toHaveBeenCalledWith("/emails?mailView=sending&senderId=sender-one&serviceId=ready");
  expect(container.textContent).not.toContain("View email plans");
});

it("resumes the selected checkout and recovers from a failed provisioning refresh", async () => {
  vi.useFakeTimers();
  try {
    const service = { id: "dedicated-order", placement: "dedicated" };
    h.service.mockResolvedValueOnce({ plan: null, service: { ...service, provisioning: "payment" } })
      .mockRejectedValueOnce(new Error("Temporary network failure"))
      .mockRejectedValueOnce(new Error("Still offline"))
      .mockResolvedValue({ plan: null, service: { ...service, provisioning: "vm" } });
    await renderView("serviceId=dedicated-order");
    h.order.mockRejectedValueOnce(new Error("Checkout unavailable"));
    await act(async () => buttonNamed("Resume checkout")!.click());
    expect(h.order).toHaveBeenCalledExactlyOnceWith(service.id, "resume");
    expect(container.textContent).toContain("Checkout unavailable");
    expect(h.checkout).not.toHaveBeenCalled();

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(container.textContent).toContain("Temporary network failure");
    await act(async () => buttonNamed("Retry")!.click());
    expect(container.textContent).toContain("Still offline");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(container.textContent).toContain("Creating your private mail server");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it("opens the existing dedicated service from the send-only Mailboxes tab", async () => {
  h.summary.mockResolvedValue({ plan: "team", product: "sending", mailboxPlan: null, service: null,
    services: [{ id: "host", placement: "dedicated", plan: "team" }] });
  await renderView("tab=mailboxes");
  expect(h.replace).toHaveBeenCalledWith("/emails?serviceId=host&tab=mailboxes");
  expect(container.textContent).not.toContain("View mailbox plans");
});

it("opens a pending sender's DNS records on return and shows the full ownership name", async () => {
  h.summary.mockResolvedValue({ plan: "team", service: null, sendingConfigured: true });
  const domain = "mail-test.example.test";
  const name = "_oblien-mail." + domain;
  h.sendingDomains.mockResolvedValue({ data: [{ id: "sender-test", domain, disabled: false, ownership: "pending" }] });
  h.sender.mockResolvedValue({ id: "sender-test", domain, state: "pending_dns", records: [{ type: "TXT", name, value: "verify=sample", status: "pending" }] });
  h.sendingKeys.mockResolvedValue({ data: [] });
  await renderView("mailView=sending");
  expect(h.sender).toHaveBeenCalledExactlyOnceWith("sender-test");
  expect(container.textContent).toContain("Publish DNS records for " + domain);
  expect(container.textContent).toContain(name);
  expect(container.textContent).toContain("verify=sample");
  expect(buttonNamed("Verify")).toBeTruthy();
  expect(container.querySelector('input[aria-label="Sender domain"]')).toBeNull();
  const back = container.querySelector<HTMLAnchorElement>('a[href*="senderView=list"]')!;
  expect(back.textContent).toBe("Sender domains");
  await renderView(back.search.slice(1));
  expect(container.querySelector('input[aria-label="Sender domain"]')).not.toBeNull();
  expect(container.textContent).not.toContain("verify=sample");
  const domainLink = container.querySelector<HTMLAnchorElement>('a[href*="senderId=sender-test"]')!;
  expect(domainLink.textContent).toBe(domain);
  await renderView(domainLink.search.slice(1));
  expect(container.textContent).toContain("verify=sample");
  expect(container.querySelector('input[aria-label="Sender domain"]')).toBeNull();
});

it("opens the submitted domain among existing senders and waits for the customer to verify", async () => {
  h.summary.mockResolvedValue({ plan: "team", mailboxPlan: "team", sendingConfigured: true, service: null });
  const domain = "new.example.test";
  const sender = { id: "chosen", domain, state: "pending_dns",
    records: [{ type: "TXT", name: "_oblien-mail." + domain, value: "verify=chosen", status: "pending" }] };
  h.sendingDomains.mockResolvedValue({ data: [{ id: "other", domain: "other.example.test" }, { id: sender.id, domain }] });
  h.sendingKeys.mockResolvedValue({ data: [] });
  h.sender.mockResolvedValue(sender);
  h.verifySender.mockResolvedValue({ ...sender, state: "ready" });
  await renderView("mailView=sending&senderId=chosen");
  expect(h.sender).toHaveBeenCalledExactlyOnceWith("chosen");
  expect(container.textContent).toContain("verify=chosen");
  expect(container.textContent).not.toContain("other.example.test");
  expect(container.querySelector('input[aria-label="Sender domain"]')).toBeNull();
  expect(h.verifySender).not.toHaveBeenCalled();
  await act(async () => buttonNamed("Verify").click());
  expect(h.verifySender).toHaveBeenCalledExactlyOnceWith("chosen");
  expect(container.textContent).toContain("Create API key");
  expect(buttonNamed("Verify").closest("section")?.querySelector('[role="status"]')?.textContent).toContain("Ready to send");
});

it("creates an OpenShip domain API key and copies its masked secret once", async () => {
  h.summary.mockResolvedValue({ plan: "team", service: null, sendingConfigured: true });
  const domain = { id: "d1", domain: "notify.test", state: "ready", records: [] };
  const credential = { id: "new", key: "opsh_send_example_fixture" };
  const other = { id: "k2", domainId: "d2", name: "Second domain", prefix: "prefix2" };
  const key = { id: "new", domainId: "d1", name: "App key", prefix: "prefix1", createdAt: "2026-11-24T12:00:00Z", lastUsedAt: null };
  h.sendingDomains.mockResolvedValue({ data: [domain] });
  h.sender.mockResolvedValue(domain);
  h.sendingKeys.mockResolvedValueOnce({ data: [other] })
    .mockResolvedValueOnce({ data: [other, key] })
    .mockResolvedValue({ data: [other] });
  h.issueKey.mockResolvedValue(credential);
  const copy = vi.spyOn(clipboard, "copyText").mockResolvedValue(undefined);
  try {
    await renderView("tab=sending&senderId=d1");
    const card = container.querySelector('section[aria-label="API keys"]')!;
    expect(card.textContent).toContain("OpenShip Mail API");
    expect(card.textContent).not.toContain(other.name);
    const guide = container.querySelector('aside[aria-label="Send from your app"]')!;
    expect(guide.querySelector('a[href$="/docs/api/mail#sdk-example"]')?.textContent).toBe("SDK example");
    expect(guide.querySelector('a[href$="/docs/api/mail#send-email"]')?.textContent).toBe("API reference");
    expect(card.textContent).toContain("No API keys yet");
    await act(async () => guide.querySelector<HTMLButtonElement>('button[aria-label="Copy endpoint URL"]')!.click());
    expect(copy).toHaveBeenLastCalledWith("https://api.cloud.example.test/api/mail/send");
    await act(async () => guide.querySelector("summary")!.click());
    await act(async () => guide.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')!.click());
    const request = String(copy.mock.calls.at(-1)?.[0]);
    expect(request).toMatch(/^curl https:\/\/api\.cloud\.example\.test\/api\/mail\/send /);
    expect(request).toContain("hello@notify.test");
    expect(request).toContain("$OPENSHIP_MAIL_API_KEY");
    expect(request).not.toContain(credential.key);
    await act(async () => buttonNamed("Create API key").click());
    expect(h.issueKey).toHaveBeenCalledExactlyOnceWith(domain.id);
    const dialog = document.querySelector('section[aria-label="API key created"]')!;
    expect(dialog.textContent).not.toContain("Namespace");
    expect(document.body.textContent).not.toContain(credential.key);
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Copy · API key"]')!.click());
    expect(copy).toHaveBeenCalledWith(credential.key);
    await act(async () => dialog.querySelector<HTMLButtonElement>('button[aria-label="Show · API key"]')!.click());
    expect(dialog.textContent).toContain(credential.key);
    await act(async () => [...dialog.querySelectorAll("button")].find(b => b.textContent === "Done")!.click());
    expect(document.body.textContent).not.toContain(credential.key);
    expect(card.textContent).not.toContain("Namespace");
    expect(card.textContent).toContain(key.prefix);
    expect(card.textContent).toContain("Nov 24, 2026");
    expect(card.textContent).toContain("Never");
    await act(async () => card.querySelector<HTMLButtonElement>('button[aria-label="Actions for prefix1"]')!.click());
    await act(async () => buttonNamed("Revoke").click());
    expect(h.revokeKey).toHaveBeenCalledExactlyOnceWith(key.id);
    expect(card.textContent).not.toContain(key.prefix);
  } finally {
    copy.mockRestore();
  }
});

it("shows a repeat check in progress, inline errors on failure, and the provider result even while DKIM stays pending", async () => {
  h.summary.mockResolvedValue({ plan: "team", sendingConfigured: true, service: null });
  const domain = "mail-test.example.test";
  const sender = { id: "dkim", domain, state: "verifying", reason: null, checkedAt: "2026-11-25T19:34:18.000Z",
    records: ["verified", "pending", "lookup_error"].map((status, i) => ({
      type: "CNAME", name: `s${i}._domainkey.${domain}`, value: `s${i}.example.test`, status,
    })),
  };
  h.sendingDomains.mockResolvedValue({ data: [{ id: sender.id, domain, ownership: "verified" }] });
  h.sendingKeys.mockResolvedValue({ data: [] });
  h.sender.mockResolvedValueOnce(sender);
  let complete!: (result: typeof sender) => void;
  h.verifySender.mockRejectedValueOnce(new Error("Verification temporarily unavailable"))
    .mockImplementationOnce(() => new Promise<typeof sender>(resolve => { complete = resolve; }));
  await renderView("mailView=sending");
  const verify = buttonNamed("Verify");
  const section = verify.closest("section")!;
  const feedback = section.querySelector('[role="status"]')!;
  expect(section.textContent).toContain("DNS lookup failed");
  expect(section.textContent).toContain("Awaiting confirmation");
  expect(section.textContent).toContain("Verified");
  await act(async () => verify.click());
  expect(section.querySelector('[role="alert"]')?.textContent).toContain("Verification temporarily unavailable");
  await act(async () => verify.click());
  expect(verify.disabled).toBe(true);
  expect(feedback.textContent).toContain("Checking DNS");
  expect(section.querySelector('[role="alert"]')).toBeNull();
  await act(async () => complete(sender));
  expect(verify.disabled).toBe(false);
  expect(feedback.textContent).toContain("1 of 3 DNS records confirmed");
  expect(feedback.querySelector("time")?.dateTime).toBe(sender.checkedAt);
  expect(h.verifySender).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Create API key");
});

it("keeps sending records available to a previously configured organization", async () => {
  h.summary.mockResolvedValue({ plan: null, service: null, sendingConfigured: true });
  h.sendingDomains.mockResolvedValue({ data: [] });
  h.sendingKeys.mockResolvedValue({ data: [] });
  h.sendingUsage.mockResolvedValue({ usedPeriod: 9, reservedPeriod: 2, policy: { period: 500 } });
  await renderView("mailView=sending");
  expect(container.textContent).toContain("9 accepted · 2 pending");
  expect(container.querySelector('[role="meter"][aria-label="Monthly sending"]')?.textContent).toBe("1%");
  expect(container.textContent).toContain("489 recipients left");
  expect(container.querySelector('input[aria-label="Sender domain"]')).toBeNull();
});

it("recovers domain usage, edits its cap, and displays the shared allowance to a read-only user", async () => {
  h.summary.mockResolvedValue({ plan: "solo", service: null, sendingConfigured: true });
  h.sendingDomains.mockResolvedValue({ data: [{ id: "d1", domain: "example.test" }] });
  h.sendingKeys.mockResolvedValue({ data: [] });
  const usage = {
    data: [{ identity: "example.test", monthlyCap: 100, accepted: 17, pending: 2 }],
    monthStart: "2026-11-01T00:00:00Z",
    resetAt: "2026-12-01T00:00:00Z",
    unattributed: { accepted: 0, pending: 0 },
  };
  h.identityUsage.mockRejectedValueOnce(new Error("Could not load domain usage"));
  await renderView("mailView=sending&senderView=list");
  const domain = container.querySelector("li")!;
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load domain usage");
  expect(domain.querySelector('[role="meter"]')).toBeNull();
  expect(domain.textContent).toContain("— / 500");

  h.identityUsage.mockResolvedValueOnce({ usage, canEdit: true });
  await act(async () => buttonNamed("Refresh").click());
  expect(h.identityUsage).toHaveBeenLastCalledWith("domains");
  expect(domain.querySelector('[role="meter"]')?.getAttribute("aria-valuenow")).toBe("19");
  const edit = 'button[aria-label="Domain sending limit · example.test"]';
  await act(async () => domain.querySelector<HTMLButtonElement>(edit)!.click());
  const drawer = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Domain sending limit"]')!;
  expect(drawer.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
  await act(async () => drawer.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  h.setCap.mockResolvedValueOnce({ success: true });
  h.identityUsage.mockResolvedValueOnce({
    canEdit: false,
    usage: { ...usage, data: [{ ...usage.data[0]!, monthlyCap: null }] },
  });
  await act(async () => drawer.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(h.setCap).toHaveBeenCalledExactlyOnceWith("domains", "example.test", null);
  expect(domain.textContent).toContain("19 / 500");
  expect(domain.querySelector(edit)).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("discloses the overview sending breakdown without refetching usage", async () => {
  h.summary.mockResolvedValue({
    plan: "included", sendingConfigured: true,
    service: { id: "managed-mail-test", placement: "standard", hostname: "mail.example.org", webmailUrl: "https://webmail.example.org" },
  });
  h.sendingUsage.mockResolvedValue({ usedPeriod: 9, reservedPeriod: 2, policy: { period: 500 } });
  await renderView("tab=overview");
  const trigger = buttonNamed("Monthly sending");
  expect(container.textContent).not.toContain("489 recipients left");
  expect(container.querySelector('[role="meter"][aria-label="Monthly sending"]')?.textContent).toBe("1%");
  await act(async () => trigger.click());
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("9 accepted · 2 pending");
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("489 recipients left");
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(h.sendingUsage).toHaveBeenCalledTimes(1);
});
it("starts a Team subscriber at manual domain setup even when shared hosting is unavailable", async () => {
  h.summary.mockResolvedValue({ plan: "team", mailboxPlan: "team", service: null, hostingAvailable: false, sendingConfigured: true });
  h.sendingDomains.mockResolvedValue({ data: [] });
  h.sendingKeys.mockResolvedValue({ data: [] });
  h.connectDomain.mockResolvedValue({ id: "added-domain", domain: "mail.example.test", state: "pending_dns", records: [] });
  await renderView();
  expect(container.textContent).toContain("Connect your domain");
  expect(container.querySelector("picture")).toBeNull();
  expect(container.textContent).toContain("Shared hosting is currently unavailable");
  expect(container.textContent).not.toContain("View email plans");
  expect(container.textContent).not.toContain("Dedicated mail server");
  expect(h.activate).not.toHaveBeenCalled();
  expect(h.connectDomain).not.toHaveBeenCalled();
  expect(h.sender).not.toHaveBeenCalled();
  const input = container.querySelector<HTMLInputElement>('input[name="domain"]')!;
  expect(input.value).toBe("");
  expect(buttonNamed("Connect domain").disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "mail.example.test");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(h.connectDomain).toHaveBeenCalledExactlyOnceWith("mail.example.test");
  expect(h.navigate).toHaveBeenCalledWith("/emails?mailView=sending&senderId=added-domain", { scroll: false });
});

it("previews included inboxes and rechecks capacity from the Team Mailboxes tab", async () => {
  const summary = { plan: "team", mailboxPlan: "team", product: "mailboxes", service: null, hostingAvailable: false, sendingConfigured: true };
  h.summary.mockResolvedValue(summary);
  await renderView("tab=mailboxes&preview=sending-limits");

  const preview = container.querySelector('a[href="/mail/inbox-preview.webp"]');
  expect(preview?.querySelector('img[alt="Preview of the OpenShip Mail inbox"]')).not.toBeNull();
  expect(preview?.getAttribute("target")).toBe("_blank");
  expect(container.textContent).toContain("Mailboxes are included in your plan");
  expect(container.textContent).not.toContain("View mailbox plans");
  const sending = [...container.querySelectorAll("a")].find(a => a.textContent === "Manage sending");
  expect(new URLSearchParams(sending?.search).get("mailView")).toBe("sending");
  expect(h.stats).not.toHaveBeenCalled();
  expect(h.mailboxes).not.toHaveBeenCalled();

  let finish!: (value: typeof summary) => void;
  h.summary.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await act(async () => buttonNamed("Check availability").click());
  expect(buttonNamed("Checking…").disabled).toBe(true);
  await act(async () => finish(summary));
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Shared hosting is still unavailable.");

  h.summary.mockResolvedValueOnce({ ...summary, hostingAvailable: true });
  await act(async () => buttonNamed("Check availability").click());
  expect(buttonNamed("Activate mailboxes").disabled).toBe(false);
  expect(container.textContent).not.toContain("unavailable");
  expect(h.activate).not.toHaveBeenCalled();
});

it("reveals sender domains before their usage arrives and keeps the table in place", async () => {
  h.summary.mockResolvedValue({ plan: "team", mailboxPlan: "team", service: null, sendingConfigured: true });
  const domain = { id: "first", domain: "first.test", ownership: "verified" };
  let finishDomains!: () => void;
  let finishUsage!: () => void;
  h.sendingDomains.mockImplementationOnce(() => new Promise(resolve => {
    finishDomains = () => resolve({ data: [domain] });
  }));
  h.identityUsage.mockImplementationOnce(() => new Promise(resolve => {
    finishUsage = () => resolve({ usage: { data: [{ identity: domain.domain, accepted: 8, pending: 2, monthlyCap: 100 }] } });
  }));

  await renderView("tab=domains");
  const table = container.querySelector('table[aria-busy="true"]')!;
  expect(table.querySelectorAll('tbody tr[aria-hidden="true"]')).toHaveLength(2);
  expect(container.querySelector('input[name="domain"]')).toBeNull();
  expect(h.identityUsage).not.toHaveBeenCalled();

  await act(async () => finishDomains());
  expect(container.querySelector("table")).toBe(table);
  expect(table.hasAttribute("aria-busy")).toBe(false);
  expect(table.querySelector("tbody a")?.textContent).toBe(domain.domain);
  expect(table.querySelector('td:nth-child(2) [aria-busy="true"]')).not.toBeNull();

  await act(async () => finishUsage());
  expect(table.querySelector('[aria-busy="true"]')).toBeNull();
  expect(table.textContent).toContain("10 / 100");
  expect(h.sender).not.toHaveBeenCalled();
});

it("keeps a direct DNS visit in the record view while the domain and its records load", async () => {
  h.summary.mockResolvedValue({ plan: "team", mailboxPlan: "team", service: null, sendingConfigured: true });
  const domain = { id: "first", domain: "first.test", ownership: "pending" };
  let finishDomains!: () => void;
  let finishRecords!: () => void;
  h.sendingDomains.mockImplementationOnce(() => new Promise(resolve => {
    finishDomains = () => resolve({ data: [domain] });
  }));
  h.sender.mockImplementationOnce(() => new Promise(resolve => {
    finishRecords = () => resolve({ ...domain, state: "pending_dns", records: [] });
  }));

  await renderView("tab=dns&domain=first.test");
  expect(container.querySelector("table")).toBeNull();
  expect(container.textContent).toContain(domain.domain);
  expect(container.textContent).toContain("DNS records");
  expect(h.sender).not.toHaveBeenCalled();
  await act(async () => finishDomains());
  expect(h.sender).toHaveBeenCalledExactlyOnceWith(domain.id);
  expect(container.querySelector("table")).toBeNull();
  expect(container.textContent).toContain("DNS records");
  await act(async () => finishRecords());
  expect(buttonNamed("Verify").disabled).toBe(false);
});

it("opens verified domains on sending, and keeps DNS setup available for pending domains and explicit reviews", async () => {
  h.summary.mockResolvedValue({ plan: "team", mailboxPlan: "team", service: null, sendingConfigured: true });
  const first = { id: "first", domain: "first.test", ownership: "pending" };
  const second = { id: "second", domain: "second.test", ownership: "verified" };
  const record = { type: "CNAME", name: "key._domainkey.second.test", value: "key.dkim.example.test", status: "pending" };
  const pending = { ...second, state: "verifying", records: [record] };
  h.sendingDomains.mockResolvedValue({ data: [first, second] });
  h.sender.mockResolvedValue(pending);
  h.verifySender.mockResolvedValue({ ...pending, state: "ready", checkedAt: "2026-11-25T12:00:00Z",
    records: [{ ...record, status: "verified" }] });

  h.identityUsage.mockResolvedValue({ canEdit: false, usage: {
    data: [{ identity: second.domain, accepted: 8, pending: 2, monthlyCap: 100 }],
  } });
  await renderView("tab=domains&domain=second.test");
  const table = container.querySelector("table")!;
  const readyRow = [...table.querySelectorAll("tbody tr")].find(row => row.textContent?.includes(second.domain))!;
  const pendingRow = [...table.querySelectorAll("tbody tr")].find(row => row.textContent?.includes(first.domain))!;
  expect(readyRow.textContent).toContain("Ownership verified");
  expect(readyRow.textContent).toContain("10 / 100");
  expect(readyRow.querySelector("a")?.getAttribute("href")).toContain("mailView=sending&senderId=second");
  expect(pendingRow.querySelector("a")?.getAttribute("href")).toBe("?tab=dns&domain=first.test");
  expect(h.identityUsage).toHaveBeenCalledExactlyOnceWith("domains");
  expect(h.sender).not.toHaveBeenCalled();
  expect(container.querySelector("details")).toBeNull();
  expect(container.textContent).not.toContain("DNS records");

  await act(async () => readyRow.querySelector<HTMLButtonElement>("button[aria-expanded]")!.click());
  await act(async () => buttonNamed("Review DNS records").click());
  expect(h.navigate).toHaveBeenCalledWith("?tab=dns&domain=second.test", { scroll: false });
  await renderView("tab=dns&domain=second.test");
  expect(h.sender).toHaveBeenCalledExactlyOnceWith("second");
  expect(container.textContent).toContain("Confirming sending records");
  expect(container.querySelector("details")?.open).toBe(true);
  expect(container.querySelector("details")?.textContent).toContain(record.name);
  expect(container.querySelector("details")?.textContent).toContain(record.value);
  expect(container.querySelector('input[name="domain"]')).toBeNull();
  expect(h.verifySender).not.toHaveBeenCalled();

  await act(async () => buttonNamed("Verify").click());
  expect(h.verifySender).toHaveBeenCalledExactlyOnceWith("second");
  expect(h.replace).toHaveBeenCalledWith("/emails?mailView=sending&senderId=second", { scroll: false });
  expect(container.textContent).toContain("Ready to send");
  expect(container.querySelector("details")?.open).toBe(false);
  expect(h.sender).toHaveBeenCalledTimes(1);

  const back = [...container.querySelectorAll("a")].find(link => link.textContent === "Sender domains")!;
  await renderView(back.search.slice(1));
  expect(container.querySelector("table")).not.toBeNull();
  expect(container.querySelector("details")).toBeNull();

  h.connectDomain.mockResolvedValue({ id: "third", domain: "third.test", state: "pending_dns" });
  await act(async () => buttonNamed("Connect domain").click());
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[name="domain"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "third.test");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(h.connectDomain).toHaveBeenCalledExactlyOnceWith("third.test");
  expect(h.navigate).toHaveBeenCalledWith("?tab=dns&domain=third.test", { scroll: false });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("keeps a returning Team subscriber in the mail dashboard from Overview through a test send", async () => {
  h.summary.mockResolvedValue({ plan: "team", mailboxPlan: "team", service: null, hostingAvailable: false, sendingConfigured: true });
  const domain = { id: "team", domain: "team.test" };
  const receipt = { id: "msg1", state: "queued", reason: null };
  h.sendingDomains.mockResolvedValue({ data: [domain] });
  const pending = { ...domain, state: "verifying", records: [] };
  h.sender.mockResolvedValue(pending);
  h.sendingKeys.mockResolvedValue({ data: [] });
  h.testEmail.mockRejectedValueOnce(new Error("Request timed out")).mockResolvedValueOnce({ from: "openship@team.test", to: "reader@example.test", receipt });
  h.message.mockResolvedValueOnce({ ...receipt, state: "delivered" });
  await renderView();
  const active = () => container.querySelector('a[aria-current="page"]')?.textContent;
  expect(active()).toBe("Overview");
  expect([...container.querySelectorAll('a[href^="?tab="]')].map(a => a.textContent)).toEqual([
    "Overview", "Mailboxes", "Domains", "Sending",
  ]);
  expect(container.textContent).toContain("Monthly sending");
  expect(container.textContent).toContain("Mailbox activity");
  expect(container.textContent).not.toContain("Send test email");
  await renderView("tab=mailboxes");
  expect(active()).toBe("Mailboxes");
  expect(container.textContent).toContain("Shared hosting is currently unavailable");
  await renderView("tab=domains");
  expect(active()).toBe("Domains");
  const senderLink = [...container.querySelectorAll<HTMLAnchorElement>("table a")].find(link => link.textContent === domain.domain)!;
  expect(senderLink.getAttribute("href")).toBe("/emails?mailView=sending&senderId=team");
  expect(h.stats).not.toHaveBeenCalled();
  expect(h.mailboxes).not.toHaveBeenCalled();
  await renderView(new URL(senderLink.href, "http://localhost").search.slice(1));
  expect(active()).toBe("Sending");
  expect(container.textContent).not.toContain("Connect your domain");
  await act(async () => buttonNamed("Send test email").click());
  const form = document.querySelector<HTMLInputElement>('input[type="email"]')!.form!;
  expect(form.textContent).toContain("openship@team.test");
  expect(h.mailboxDomains).not.toHaveBeenCalled();
  expect(h.testEmail).not.toHaveBeenCalled();
  const input = form.querySelector<HTMLInputElement>('input[type="email"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "reader@example.test");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submit = () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  h.sender.mockResolvedValue({ ...pending, state: "ready" });
  await act(async () => [...form.querySelectorAll("button")].find(b => b.textContent === "Refresh")!.click());
  expect(input.value).toBe("reader@example.test");
  expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  expect(h.testEmail).not.toHaveBeenCalled();
  await act(async () => { submit(); });
  expect(form.textContent).toContain("Request timed out");
  await act(async () => { submit(); });
  expect(h.testEmail.mock.calls[0]).toEqual(["team", { to: "reader@example.test", idempotencyKey: expect.any(String) }]);
  expect(h.testEmail.mock.calls[1]).toEqual(h.testEmail.mock.calls[0]);
  const modal = document.querySelector('section[aria-label="Test email"]')!;
  expect(modal.textContent).toContain("Queued for sending");
  expect(modal.textContent).toContain("msg1");
  await act(async () => [...modal.querySelectorAll("button")].find(b => b.textContent === "Refresh")!.click());
  expect(modal.textContent).toContain("Accepted by the recipient’s mail server");
});

it("retains activation for an explicitly reserved mailbox host", async () => {
  h.summary.mockResolvedValue({ plan: "team", service: null, hostingAvailable: false, reservedHostingAvailable: true });
  h.activate.mockRejectedValueOnce(new Error("Worker unavailable"));
  await renderView();
  await act(async () => buttonNamed("Activate mailboxes").click());
  expect(h.activate).toHaveBeenCalledWith("dedicated", undefined);
  expect(container.textContent).toContain("Worker unavailable");
});

it("takes the legacy dedicated entry to dedicated mail pricing without loading customer VMs", async () => {
  h.summary.mockResolvedValue({ plan: null, service: null });
  await renderView("hosting=cloud&mailView=dedicated");
  expect(container.textContent).toContain("Dedicated mail server");
  expect(container.querySelector('a[href*="mailProduct=dedicated"]')?.textContent).toContain(
    "View email plans",
  );
  expect(h.destinations).not.toHaveBeenCalled();
  expect(h.activate).not.toHaveBeenCalled();
});

it("keeps active mailbox services inside their admin panel on an API deep link", async () => {
  h.summary.mockResolvedValue({
    plan: "included",
    service: {
      id: "managed-mail-test",
      placement: "standard",
      hostname: "mail.example.org",
      webmailUrl: "https://webmail.example.org",
    },
  });
  await renderView("mailView=sending");
  expect(container.querySelector('input[aria-label="Sender domain"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Aliases");
  expect(container.querySelector('a[aria-current="page"]')?.textContent).toBe("Sending");
  expect(container.querySelector("legend")).toBeNull();
  expect(h.catalog).not.toHaveBeenCalled();
});

it("shows the reserved VM state until its mail worker is ready", async () => {
  h.summary.mockResolvedValue({
    plan: "included",
    service: {
      id: "managed-mail-pending",
      placement: "dedicated",
      cloudServerId: "vm",
      provisioning: "network",
    },
  });
  await act(async () =>
    root.render(
      <PlatformProvider selfHosted={false} deployMode="cloud" authMode="cloud">
        <I18nProvider>
          <MailConsole />
        </I18nProvider>
      </PlatformProvider>,
    ),
  );
  expect(container.getElementsByTagName("button").length).toBeGreaterThan(0);
  expect(container.textContent).toContain("Cancel VM request");
  expect(container.textContent).not.toContain("IMAP 993");
  expect(h.stats).not.toHaveBeenCalled();
});

function mockMailPlans() {
  h.summary.mockResolvedValue({ plan: null, service: null, hostingAvailable: true });
  h.catalog.mockReturnValue({
    loading: false,
    payload: {
      mail: {
        products: {
          mailboxes: { name: "Shared mailboxes" },
          dedicated: { name: "Dedicated mail server" },
          sending: { name: "Sending API" },
        },
        dedicatedStorage: [
          { storageGB: 100, vmMonthlyCents: 2400 },
          { storageGB: 200, vmMonthlyCents: 2900 },
        ],
        tiers: [
          {
            id: "team",
            name: "Team",
            description: "For small teams.",
            checkoutPlan: "team",
            popular: true,
            monthlyCents: 900,
            sendingMonthlyCents: 500,
            domains: 50,
            mailboxes: 5,
            storageMB: 25600,
            recipients: 25000,
          },
        ],
      },
    },
  });
  h.checkout.mockRejectedValue(new Error("Offline checkout"));
}

it("uses the same pricing card for mailbox and sending checkout at their respective prices", async () => {
  mockMailPlans();
  await act(async () =>
    root.render(
      <I18nProvider>
        <EmailPlans requestedPlan="team" />
      </I18nProvider>,
    ),
  );
  expect(container.querySelector('article[aria-current="true"]')?.textContent).toContain("$9");
  await act(async () => buttonNamed("Choose Team").click());
  expect(h.checkout).toHaveBeenCalledExactlyOnceWith("team", "mailboxes");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[value="sending"]')!.click(),
  );
  const card = container.querySelector("article")!;
  expect(card.textContent).toContain("$5");
  expect(card.textContent).toContain("Most popular");
  expect(card.textContent).toContain("25,000");
  expect(card.textContent).not.toContain("Storage");
  await act(async () => buttonNamed("Choose Team").click());
  expect(h.checkout).toHaveBeenLastCalledWith("team", "sending");
});

it("offers a paid sender the same tier with mailboxes through subscription review", async () => {
  mockMailPlans();
  h.summary.mockResolvedValue({ plan: "team", product: "sending", mailboxPlan: null, service: null,
    subscriptionTarget: "account", subscriptionPlan: { plan: "team", product: "sending" } });
  h.changeStatus.mockResolvedValue({ change: null, pending: false });
  h.previewChange.mockRejectedValue(new Error("Quote unavailable"));
  await act(async () => root.render(<I18nProvider><EmailPlans requestedProduct="mailboxes" /></I18nProvider>));
  const choose = buttonNamed("Choose Team");
  expect(choose.disabled).toBe(false);
  await act(async () => choose.click());
  expect(h.previewChange).toHaveBeenCalledExactlyOnceWith("account", {
    plan: "team", product: "mailboxes", idempotencyKey: expect.any(String), storageGB: undefined,
  });
  expect(h.checkout).not.toHaveBeenCalled();
  expect(h.confirmChange).not.toHaveBeenCalled();
});

it("configures storage in the chosen dedicated plan and uses its reviewed price for checkout", async () => {
  mockMailPlans();
  await act(async () =>
    root.render(
      <I18nProvider>
        <EmailPlans requestedProduct="dedicated" />
      </I18nProvider>,
    ),
  );
  expect(document.querySelector('select, input[type="radio"]')).toBeNull();
  const card = container.querySelector("article")!;
  for (const label of card.querySelectorAll("dt"))
    expect(label.querySelector("svg")).not.toBeNull();
  await act(async () => buttonNamed("Choose Team").click());
  const dialog = document.querySelector('[role="dialog"]')!;
  const size = (gb: number) => dialog.querySelector<HTMLInputElement>(`input[value="${gb}"]`)!;
  expect(size(100).checked).toBe(true);
  const confirm = [...dialog.querySelectorAll("button")].find(
    (b) => b.textContent === "Continue to checkout",
  )!;
  await act(async () => confirm.click());
  const originalId = h.checkout.mock.calls[0]![2].purchaseId;
  await act(async () => size(200).click());
  expect(dialog.querySelector('[aria-live="polite"]')?.textContent).toContain("$34");
  expect(card.textContent).toContain("100 GB");
  await act(async () => confirm.click());
  expect(h.checkout).toHaveBeenLastCalledWith("team", "dedicated", {
    storageGB: 200,
    expectedMonthlyCents: 3400,
    purchaseId: expect.any(String),
  });
  const newId = h.checkout.mock.calls[1]![2].purchaseId;
  expect(newId).not.toBe(originalId);
  await act(async () => confirm.click());
  expect(h.checkout.mock.calls[2]![2].purchaseId).toBe(newId);
});

it("opens a linked dedicated plan at the requested size and waits for confirmation", async () => {
  mockMailPlans();
  await act(async () =>
    root.render(
      <I18nProvider>
        <EmailPlans requestedProduct="dedicated" requestedPlan="team" requestedStorage={200} />
      </I18nProvider>,
    ),
  );
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector<HTMLInputElement>('input[value="200"]')?.checked).toBe(true);
  await act(async () =>
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(h.checkout).not.toHaveBeenCalled();
});

it.each(["mailboxes", "sending", "dedicated"])(
  "opens the current %s subscription and confirms its quoted price",
  async (product) => {
    mockMailPlans();
    const target = product === "dedicated" ? "managed-mail-123" : "account";
    const account = {
      plan: "solo",
      subscriptionTarget: target,
      product,
      defaultProduct: product,
      service: null,
      services: product === "dedicated" ? [{ id: target, plan: "solo", storageGB: 100 }] : [],
    };
    h.summary.mockResolvedValue(account);
    await renderView();
    expect(container.querySelector('a[href*="changeMail="]')?.getAttribute("href")).toContain(
      "changeMail=" + target,
    );
    h.changeStatus.mockResolvedValue({ change: null, pending: false });
    await act(async () =>
      root.render(
        <I18nProvider>
          <EmailPlans changeTarget={target} />
        </I18nProvider>,
      ),
    );
    const quote = {
      id: "quote",
      current: { name: "Solo", priceCents: 300 },
      next: { name: "Team", priceCents: 900 },
      direction: "upgrade",
      currency: "usd",
      allowances: {
        current: { domains: 10, recipients: 5000 },
        next: { domains: 50, recipients: 25000 },
      },
      amountDueNow: 150,
      unusedTimeCredit: 100,
      remainingTimeCharge: 250,
      nextInvoiceAmount: 900,
      interval: "monthly",
      effectiveAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      resize: null,
    };
    h.previewChange.mockResolvedValue(quote);
    h.confirmChange.mockResolvedValue({
      ...quote,
      id: "change",
      status: "payment_pending",
      paymentUrl: "https://invoice.stripe.com/pay/test",
      cancelable: true,
    });
    await act(async () => buttonNamed("Choose Team").click());
    if (product === "dedicated") {
      const config = document.querySelector<HTMLElement>('[role="dialog"]')!;
      await act(async () => config.querySelector<HTMLInputElement>('input[value="200"]')!.click());
      await act(async () =>
        [...config.querySelectorAll("button")]
          .find((b) => b.textContent === "Review plan change")!
          .click(),
      );
    }
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.textContent).toContain("$1.50");
    expect(dialog.querySelector("table")?.textContent).toContain("Monthly recipients5,00025,000");
    expect(h.previewChange).toHaveBeenCalledWith(target, {
      plan: "team",
      storageGB: product === "dedicated" ? 200 : undefined,
      idempotencyKey: expect.any(String),
    });
    expect(h.confirmChange).not.toHaveBeenCalled();
    const confirm = [...dialog.querySelectorAll("button")].find((b) =>
      b.textContent?.toLowerCase().includes("confirm upgrade"),
    )!;
    await act(async () => confirm.click());
    expect(h.confirmChange).toHaveBeenCalledExactlyOnceWith(target, "quote");
    expect(dialog.querySelector('a[href^="https://invoice.stripe.com/"]')).not.toBeNull();
    expect(h.checkout).not.toHaveBeenCalled();
  },
);

it.each(["desktop", "self-hosted"] as const)("links Cloud from %s Sending and restores domain routing on return", async mode => {
  const sender = { id: "d1", domain: "example.net", state: "ready", records: [] };
  h.sendingDomains.mockResolvedValue({ data: [sender] });
  h.sender.mockResolvedValue(sender);
  h.sendingKeys.mockResolvedValue({ data: [] });
  h.webmailKey.mockResolvedValue({ sending: null });
  const render = () => act(async () => root.render(
    <PlatformProvider selfHosted={mode === "self-hosted"} deployMode={mode === "desktop" ? "desktop" : "selfhosted"} authMode="local">
      <I18nProvider><ModalProvider><InstanceSending serverId="my-vps" primaryDomain={sender.domain} webmailReady /></ModalProvider></I18nProvider>
    </PlatformProvider>));
  await render();
  expect(h.summary).not.toHaveBeenCalled();
  await act(async () => buttonNamed("Connect to OpenShip Cloud").click());
  expect(h.startConnect).toHaveBeenCalledOnce();
  h.linked = true;
  h.summary.mockResolvedValue({ plan: null });
  await render();
  expect(container.querySelector('a[href*="mailProduct=sending"]')?.getAttribute('href')).toContain("organizationId=cloud-org");
  h.summary.mockResolvedValue(mode === "desktop"
    ? { plan: null, sendingConfigured: true, sendingAllowance: 25_000 }
    : { plan: "team", sendingConfigured: true, limits: { recipients: 25_000 } });
  await act(async () => root.render(null));
  await render();
  h.connectWebmail.mockImplementation(async () => {
    h.webmailKey.mockResolvedValue({ sending: { apiOrigin: "https://api.example.net", keyId: "pat_send" } });
    h.sendingKeys.mockResolvedValue({ data: [{ id: "pat_send", domainId: sender.id, prefix: "opsh_send", createdAt: "2026-01-01" }] });
  });
  await act(async () => buttonNamed("Enable webmail sending").click());
  expect(h.connectWebmail).toHaveBeenCalledWith("my-vps", sender.id);
  expect(buttonNamed("Sending enabled").disabled).toBe(true);
  h.enableApiRelay.mockImplementation(async () => {
    h.apiRelay.mockResolvedValue({ keyId: "relay-key" });
    h.sendingKeys.mockResolvedValue({ data: [
      { id: "pat_send", domainId: sender.id, prefix: "opsh_send", createdAt: "2026-01-01" },
      { id: "relay-key", domainId: sender.id },
    ] });
  });
  await act(async () => buttonNamed("Enable API relay").click());
  expect(h.enableApiRelay).toHaveBeenCalledWith("my-vps", sender.id);
  await act(async () => root.render(null));
  await render();
  h.disableApiRelay.mockImplementation(async () => h.apiRelay.mockResolvedValue({ keyId: null }));
  await act(async () => buttonNamed("Disable API relay").click());
  expect(h.disableApiRelay).toHaveBeenCalledWith("my-vps", sender.id);
  expect(buttonNamed("Enable API relay").disabled).toBe(false);
  expect(buttonNamed("Sending enabled").disabled).toBe(true);
});
