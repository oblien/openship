import { AppError } from "@repo/core";
import { OblienError } from "@repo/adapters";
import { diagnostics } from "@repo/core/diagnostics";
import {
  dedicatedFleet,
  enrolledMailEngine,
  enrollDedicatedVm,
  publishDedicatedDkim,
} from "./dedicated-fleet";
import { prepareCustomerWebmail } from "./customer-webmail";
import { provisionDedicatedOrder } from "./dedicated";
import { sendingNamespace } from "./billing";
import { repos } from "@repo/db";
import { tryWithProvisionLock } from "../../lib/provision-lock";
import { engineRequest, engineResponse, workerStatus, bindReadyMailEngine } from "./engine-client";
import {
  engineIdentity,
  mailEngines,
  requireMailEntitlement,
  requireMailVm,
  type MailEngine,
} from "./service";

/** The pool operator supplies isolated Linux targets. One pass advances the
 * existing resumable installer. DNS, certificate and webmail readiness are
 * observed on the owning worker and survive a SaaS process restart. */
export async function prepareMailEngine(engine: MailEngine, customerOwnsApp = false) {
  const id = engine.serverId;
  const domain = engine.hostname.replace(/^mail\./, "");
  const status = await workerStatus(engine);
  if (status.serverId !== id || (status.domain && status.domain !== domain))
    throw new AppError("A mail slot points to a different installation.", 409);
  if (status.active || status.observationError) return;
  if (status.finishedAt) {
    if (
      !customerOwnsApp &&
      !status.webmail?.projectId &&
      !status.webmail?.installed &&
      !status.webmail?.routingUnknown
    ) {
      await engineRequest(engine, "/webmail/deploy-project", "POST", {
        mailServerId: id,
        hostname: new URL(engine.webmailUrl).hostname,
        target: { kind: "self", serverId: id },
        dedicatedAssistant: engine.placement === "dedicated" && !engine.shared,
      });
    }
    return status;
  }
  if (!status.domain) {
    const scanned = await engineRequest<{ iredmailInstalled: boolean; hasState: boolean }>(
      engine,
      "/scan",
      "POST",
      { serverId: id },
    );
    if (scanned.iredmailInstalled || scanned.hasState)
      throw new AppError("Inspect the existing mail installation before adding this slot.", 409);
  }
  if (status.dnsRecords && !status.dnsAcknowledged) {
    if (engine.providerVmId && status.dnsRecords.dkim)
      await publishDedicatedDkim(engine, status.dnsRecords.dkim);
    const { checks } = await engineRequest<{ checks: Array<{ key: string; status: string }> }>(
      engine,
      "/admin/" + id + "/dns-scan",
    );
    const passes = (key: string) => checks.some((row) => row.key === key && row.status === "pass");
    if (!passes("mx") || !passes("dkim")) return;
    await engineRequest(engine, "/setup/dns-ack", "POST", { serverId: id });
  }
  const response = await engineResponse(
    engine,
    "/setup",
    "POST",
    {
      serverId: id,
      domain,
      outboundDelivery: "relay",
      config: { compose: true },
      startStep: status.resumeStep ?? 1,
    },
    30 * 60_000,
  );
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body)
    throw new AppError("The worker did not start the mail installer.", 502);
  // A disconnected dashboard must never cancel the install. Consume its
  // progress without saving logs or credentials in the Cloud control plane.
  await response.body.pipeTo(new WritableStream({ write() {} }));
}

export async function warmMailFleet() {
  for (const row of await repos.managedMail.unprovisionedOrders()) {
    try {
      await provisionDedicatedOrder(row.organizationId!, row.id);
    } catch {
      diagnostics.warn("managed-mail", "Dedicated mail provisioning will retry.", {
        serviceId: row.id,
      });
    }
  }
  const inventory = mailEngines();
  const profile = dedicatedFleet();
  if (profile) {
    for (const row of await repos.managedMail.preparingOrders()) {
      if (inventory.some((slot) => slot.providerVmId === row.cloudServerId)) continue;
      try {
        const enrolled = enrolledMailEngine(row, profile);
        if (enrolled) inventory.push(enrolled);
        else
          await tryWithProvisionLock("managed-mail:enroll:" + row.id, async () => {
            const latest = await repos.managedMail.service(row.organizationId!, row.id);
            if (latest) await enrollDedicatedVm(latest, profile);
          });
      } catch (error) {
        diagnostics.warn("managed-mail", "Dedicated worker enrollment will retry.", {
          serviceId: row.id,
          ...(error instanceof OblienError && { providerCode: error.code, requestId: error.requestId }),
        });
      }
    }
  }
  for (const engine of inventory.filter(
    (row) => row.prepare || row.cloudServerId || row.providerVmId,
  )) {
    const slot = engineIdentity(engine);
    try {
      await tryWithProvisionLock("managed-mail:slot:" + slot, async () => {
        const vmId = engine.providerVmId ?? engine.cloudServerId;
        if (vmId) {
          const pending = await repos.managedMail.pendingVm(vmId);
          if (!pending?.organizationId) return;
          if (pending.engine && (pending.engine !== slot || pending.hostname !== engine.hostname))
            return;
          if (Boolean(pending.order) !== Boolean(engine.providerVmId)) return;
          if (!pending.order) await requireMailVm(pending.organizationId, vmId);
          if (
            pending.order &&
            engine.mailboxStorageMB !== undefined &&
            engine.mailboxStorageMB < pending.order.storageGB * 1024
          )
            return;
          await requireMailEntitlement(pending.organizationId, pending.id);
          if (
            !pending.engine &&
            !(await repos.managedMail.attachVm(
              pending.id,
              pending.organizationId,
              slot,
              engine.hostname,
            ))
          )
            return;
          const observed = (engine.prepare || pending.order) ? await prepareMailEngine(engine, !!pending.order) : undefined;
          const ready = await bindReadyMailEngine(engine, sendingNamespace(pending.organizationId), {
            observed,
            requireCustomerApp: pending.order?.webmailOwner === "customer" || !!pending.order?.webmailProjectId,
            prepareCustomerApp: pending.order
              ? () => prepareCustomerWebmail({ ...pending, hostname: engine.hostname })
              : undefined,
          });
          if (ready)
            await repos.managedMail.finishProvisioning(pending.id, pending.organizationId);
          return;
        }
        if (!(await repos.managedMail.occupied(slot, engine.hostname)))
          await prepareMailEngine(engine);
      });
    } catch {
      diagnostics.warn("managed-mail", "Mail slot preparation will retry.", { slot });
    }
  }
}
