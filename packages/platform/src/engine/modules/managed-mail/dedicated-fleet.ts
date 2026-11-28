import { isIPv6 } from "node:net";
import type { Oblien } from "@repo/adapters";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import { z } from "zod";
import { env } from "../../config/env";
import { getOblienClient } from "../../lib/oblien-client";
import { resolveDnsProvider } from "../dns/registry";
import { dedicatedCoverage, orderLock } from "./dedicated";
import type { MailEngine } from "./service";
import {
  listDedicatedWorkerServers,
  parseDedicatedMailFleet,
  registerDedicatedWorkerServer,
  type DedicatedMailFleet,
} from "./dedicated-worker";

type Service = NonNullable<Awaited<ReturnType<typeof repos.managedMail.service>>>;
type VmNetwork = ReturnType<Oblien["vm"]>["network"];
type PublicIPv6 = Awaited<ReturnType<VmNetwork["getPublicIPv6"]>>;

const mailPorts = [25, 80, 443, 587, 993];

function missingMailPorts(state: PublicIPv6) {
  if (state.tcp_allow_all) return [];
  return mailPorts.filter(port => !state.tcp_ports.includes(port) &&
    !state.tcp_port_ranges?.some(({ start, end }) => start <= port && port <= end));
}

async function dedicatedMailAddress(network: VmNetwork) {
  let state = await network.getPublicIPv6();
  if (!state.supported)
    throw new AppError("This node requires an operator-routed mail worker.", 503);

  const missing = missingMailPorts(state);
  if (missing.length) {
    const firewall = await network.getFirewall();
    if (firewall.revision !== state.revision) return;
    const saved = await network.setFirewall({
      expected_revision: firewall.revision,
      private_ports: firewall.private_ports,
      public_tcp_ports: [...firewall.public_tcp_ports, ...missing],
    });
    state = await network.getPublicIPv6();
    if (state.revision !== saved.revision || missingMailPorts(state).length) return;
  }
  // The provider may save the rules even when applying them on the node fails.
  // A later provisioning pass must retry activation using the current revision.
  if (!state.enabled || !state.active) {
    state = await network.setPublicIPv6({ enabled: true, expected_revision: state.revision });
  }
  if (state.active && state.enabled && state.address && isIPv6(state.address) && !missingMailPorts(state).length)
    return state.address;
}

export function dedicatedFleet() {
  return parseDedicatedMailFleet(env.OPENSHIP_MAIL_DEDICATED_FLEET);
}

function serviceDomain(row: Service, fleet: DedicatedMailFleet) {
  return row.id + "." + fleet.domain;
}
export function enrolledMailEngine(row: Service, fleet = dedicatedFleet()): MailEngine | undefined {
  if (
    !fleet ||
    !row.cloudServerId ||
    !row.order?.worker ||
    row.order.worker.origin !== fleet.origin
  )
    return;
  const hostname = "mail." + serviceDomain(row, fleet);
  return {
    origin: fleet.origin,
    token: fleet.token,
    serverId: row.order.worker.id,
    hostname,
    webmailUrl: "https://webmail." + serviceDomain(row, fleet),
    placement: "dedicated",
    prepare: true,
    providerVmId: row.cloudServerId,
    mailboxStorageMB: row.order.storageGB * 1024,
  };
}

/** Operator DNS is confined to this service's technical domain. Customer DNS uses the normal domain flow. */
export async function publishDedicatedDkim(engine: MailEngine, record: unknown) {
  const fleet = dedicatedFleet();
  if (!fleet || engine.origin !== fleet.origin || !engine.providerVmId) return;
  const domain = engine.hostname.replace(/^mail\./, "");
  if (!domain.endsWith("." + fleet.domain)) return;
  const key = z
    .object({
      type: z.literal("TXT"),
      name: z.literal("dkim._domainkey." + domain),
      value: z.string().min(1).max(8192),
    })
    .parse(record);
  await resolveDnsProvider(fleet.dnsProvider).upsertRecord(
    { apiToken: fleet.dnsToken },
    fleet.zoneId,
    { type: "TXT", name: key.name, content: key.value },
  );
}

/** Register only the immutable VM returned for this paid order. The worker retains its
 * own SSH identity. Oblien's gateway reaches the guest independently of public mail ports. */
export async function enrollDedicatedVm(row: Service, fleet: DedicatedMailFleet) {
  if (
    !row.order ||
    row.order.worker ||
    !row.cloudServerId ||
    !row.organizationId ||
    !row.billingNamespace
  )
    return;
  if (!(await dedicatedCoverage(row))) return;
  const client = getOblienClient();
  const owned = await client.vms.get(row.cloudServerId);
  if (
    owned.id !== row.cloudServerId ||
    owned.namespace !== row.billingNamespace ||
    owned.slug !== row.billingNamespace
  )
    throw new AppError("The mail VM identity could not be verified.", 409);
  if ((owned.provisioning as { state?: string } | undefined)?.state === "failed") {
    await client.vms.retryCreation(owned.id);
    return;
  }
  const vm = client.vm(owned.id);
  const address = await dedicatedMailAddress(vm.network);
  if (!address) return;
  const domain = serviceDomain(row, fleet);
  const dns = resolveDnsProvider(fleet.dnsProvider);
  const credentials = { apiToken: fleet.dnsToken };
  // Browser hostnames are claimed by the customer's catalog App through normal routing.
  await dns.upsertRecord(credentials, fleet.zoneId, {
    type: "AAAA", name: "mail." + domain, content: address, proxied: false,
  });
  await dns.upsertRecord(credentials, fleet.zoneId, {
    type: "MX",
    name: domain,
    content: "mail." + domain,
    priority: 10,
  });
  const status = await vm.ssh.status();
  if (!status.ssh_enabled) await vm.ssh.enable({ path: "gateway" });
  await vm.ssh.setKey({ public_key: fleet.sshPublicKey, append: true });
  const connection = (await vm.ssh.status()).connection;
  if (
    !connection ||
    connection.host !== owned.id ||
    connection.user !== "root" ||
    !z.hostname().safeParse(connection.bastion).success
  )
    throw new AppError("The VM’s SSH gateway is not ready.", 503);
  const expected = {
    name: row.id,
    sshHost: connection.host,
    sshUser: connection.user,
    sshJumpHost: "root@" + connection.bastion,
  };
  const servers = await listDedicatedWorkerServers(fleet);
  const registered =
    servers.find((server) => server.name === row.id) ??
    await registerDedicatedWorkerServer(fleet, expected);
  if (
    registered.name !== expected.name ||
    registered.sshHost !== expected.sshHost ||
    registered.sshUser !== expected.sshUser ||
    registered.sshJumpHost !== expected.sshJumpHost
  )
    throw new AppError("Mail worker registration belongs to a different VM.", 409);
  const org = row.organizationId;
  await orderLock(org).run(async () => {
    const current = await repos.managedMail.service(org, row.id);
    if (current?.order && current.cloudServerId === owned.id && current.orderState === "funded")
      await repos.managedMail.updateOrder(org, row.id, {
        order: { ...current.order, worker: { id: registered.id, origin: fleet.origin } },
      });
  });
}
