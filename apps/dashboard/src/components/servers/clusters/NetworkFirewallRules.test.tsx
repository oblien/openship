// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { setDemoMode } from "@/lib/demo-mode";
import type { NetworkFirewallScope } from "@repo/core";
import { NetworkFirewallRules, type NetworkFirewallServer } from "./NetworkFirewallRules";

const f = baseDictionary.servers.networks.managed.firewallRules;
const servers: NetworkFirewallServer[] = [
  {
    serverId: "a",
    name: "Alpha",
    endpoint: "192.0.2.10",
    listenPort: 51820,
    providerId: "hetzner-dedicated",
  },
  { serverId: "b", name: "Beta", endpoint: "203.0.113.20", listenPort: 53000, providerId: "ovh" },
  {
    serverId: "c",
    name: "Gamma",
    endpoint: "198.51.100.30",
    listenPort: 54000,
    providerId: "custom",
  },
];
let root: Root;
let host: HTMLDivElement;
const write = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  write.mockReset().mockResolvedValue(undefined);
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(write);
  setDemoMode(false);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setDemoMode(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function render(members = servers, network?: NetworkFirewallScope) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <NetworkFirewallRules servers={members} network={network} />
      </I18nProvider>,
    ),
  );
}
function button(text: string, scope: ParentNode = host) {
  const value = [...scope.querySelectorAll("button")].find((node) => node.textContent === text);
  expect(value).toBeDefined();
  return value!;
}
function serverSection(name: string) {
  return [...host.querySelectorAll("h4")]
    .find((node) => node.textContent === name)!
    .closest("section")!;
}
function directionSection(server: string, direction: "inbound" | "outbound") {
  return [...serverSection(server).querySelectorAll("h5")]
    .find((node) => node.textContent === f[direction])!
    .closest("section")!;
}
function ports(server: string, direction: "inbound" | "outbound") {
  return [...directionSection(server, direction).querySelectorAll("li > span")].map(
    (cell) => cell.textContent,
  );
}

describe("firewall rule guidance", () => {
  it("omits removed pairs while preserving two-way UDP transport and showing private-access direction", async () => {
    await render([servers[0]!, servers[1]!, { ...servers[2]!, endpoint: undefined }], {
      mode: "wireguard",
      access: { version: 1, rules: [{ sourceServerId: "a", targetServerId: "b" }] },
    });
    const a = baseDictionary.servers.networks.access;
    expect(ports("Alpha", "inbound")).toEqual(["51820"]);
    expect(ports("Alpha", "outbound")).toEqual(["53000"]);
    expect(ports("Beta", "outbound")).toEqual(["51820"]);
    expect(serverSection("Gamma").textContent).toContain(a.empty);
    expect(serverSection("Alpha").textContent).toContain(a.outgoing);
    expect(host.textContent).toContain(a.transportHint);
    expect(button(f.copyAllRules).disabled).toBe(false);
    await act(async () => button(f.copyAllRules).click());
    expect(write.mock.calls[0]![0]).toContain(`${f.server}: Alpha`);
    expect(write.mock.calls[0]![0]).toContain(`${f.server}: Beta`);
    expect(write.mock.calls[0]![0]).not.toContain(`${f.server}: Gamma`);
    expect(write.mock.calls[0]![0]).not.toContain(servers[2]!.endpoint);
  });
  it("shows every server and both directions without selectors, and copies exact server or fleet rules", async () => {
    await render();
    expect(host.querySelector('[role="tablist"], [aria-haspopup="listbox"]')).toBeNull();
    expect([...host.querySelectorAll("h4")].map((node) => node.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(directionSection("Alpha", "inbound").textContent).toContain("203.0.113.20/32");
    expect(ports("Alpha", "inbound")).toEqual(["51820", "51820"]);
    expect(ports("Alpha", "outbound")).toEqual(["53000", "54000"]);
    expect(ports("Beta", "inbound")).toEqual(["53000", "53000"]);
    expect(ports("Beta", "outbound")).toEqual(["51820", "54000"]);
    expect(ports("Gamma", "inbound")).toEqual(["54000", "54000"]);
    expect(ports("Gamma", "outbound")).toEqual(["51820", "53000"]);
    await act(async () => button(f.copyRules, serverSection("Alpha")).click());
    const template = write.mock.calls[0]![0] as string;
    expect(template).toContain("inbound\tallow\tudp\t203.0.113.20/32\tany\t192.0.2.10/32\t51820");
    expect(template).toContain("outbound\tallow\tudp\t192.0.2.10/32\tany\t198.51.100.30/32\t54000");
    expect(template).not.toContain("0.0.0.0/0");
    expect(button(f.copied)).toBeDefined();
    await act(async () => button(f.copyAllRules).click());
    const fleet = write.mock.calls[1]![0] as string;
    for (const server of servers) expect(fleet).toContain(`${f.server}: ${server.name}`);
    expect(fleet).toContain("inbound\tallow\tudp\t192.0.2.10/32\tany\t203.0.113.20/32\t53000");
    expect(fleet).toContain("outbound\tallow\tudp\t198.51.100.30/32\tany\t192.0.2.10/32\t51820");
    expect(fleet).not.toContain("0.0.0.0/0");
  });

  it("waits for unresolved peers before allowing a complete copy, then updates in place", async () => {
    await render([servers[0]!, { ...servers[1]!, endpoint: "beta.example.test" }, servers[2]!]);
    expect(button(f.copyRules).disabled).toBe(true);
    expect(button(f.copyAllRules).disabled).toBe(true);
    expect(host.textContent).toContain(f.pending);
    expect(host.textContent).not.toContain("beta.example.test/32");
    await render();
    expect(button(f.copyRules).disabled).toBe(false);
    expect(button(f.copyAllRules).disabled).toBe(false);
    expect(host.textContent).not.toContain(f.pending);
  });

  it("reports a clipboard failure without claiming success", async () => {
    write.mockRejectedValue(new Error("Clipboard denied"));
    await render();
    await act(async () => button(f.copyRules).click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(f.copyFailed);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("");
    expect(button(f.copyRules).disabled).toBe(false);
  });

  it("keeps addresses blurred in demo mode and copies the actual requested CIDR", async () => {
    setDemoMode(true);
    await render();
    expect([
      ...new Set([...host.querySelectorAll('[class*="blur-"]')].map((item) => item.textContent)),
    ]).toEqual(["192.0.2.10/32", "203.0.113.20/32", "198.51.100.30/32"]);
    const copy = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${f.copy} ${f.sourceCidr}"]`,
    )!;
    await act(async () => copy.click());
    expect(write).toHaveBeenCalledWith("203.0.113.20/32");
    expect(copy.getAttribute("title")).not.toContain("203.0.113.20");
  });
  it("keeps native rules private and shows stateless return traffic alongside both directions", async () => {
    await render(
      servers.map((server, index) => ({
        ...server,
        privateIp: `10.20.0.${index + 1}`,
        interfaceName: "eth1",
      })),
      { mode: "native", probePort: 51999 },
    );
    expect(ports("Alpha", "inbound")).toEqual(["51999", "51999"]);
    expect(ports("Alpha", "outbound")).toEqual(["51999", "51999"]);
    expect(host.textContent).toContain(f.nativeReturnHint);
    expect(host.textContent).toContain("TCP / UDP");
    expect(directionSection("Alpha", "inbound").closest("details")).toBeNull();
    expect(directionSection("Alpha", "outbound").closest("details")).toBeNull();
    expect(host.textContent).not.toContain("192.0.2.");
    await act(async () => button(f.copyAllRules).click());
    const template = write.mock.calls[0]![0] as string;
    expect(template).toContain(
      "inbound\tallow\ttcp\t10.20.0.2/32\tany\t10.20.0.1/32\t51999\teth1\tprobe",
    );
    expect(template).toContain(
      "outbound\tallow\tudp\t10.20.0.1/32\t51999\t10.20.0.2/32\tany\teth1\treply",
    );
    expect(template).not.toContain("192.0.2.");
  });
});
