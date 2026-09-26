import { Resolver } from "node:dns/promises";
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  SYSTEM,
  isWildcardHostname,
  safeErrorMessage,
} from "@repo/core";
import type {
  DomainDnsChallenge as PublicChallenge,
  StartDomainDnsChallenge,
} from "@repo/contracts";
import { repos, type DomainDnsChallenge } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { trackBackgroundWork } from "../../lib/background-work";
import { decryptSecretField, encryptSecretField } from "../../lib/credential-encryption";
import {
  installDomainCert,
  sslIssueLockKey,
  tlsIssuedElsewhere,
  verifyExistingCert,
  withDomainDnsCertificateProvider,
} from "../../lib/domain-ssl";
import { createProvisionLock } from "../../lib/provision-lock";
import { findActiveDeployment } from "../../lib/active-deployment";
import { resolveEffectiveTarget, type DeploymentMeta } from "../../lib/deployment-runtime";
import { platform } from "../../lib/platform-config";
import { getDomain, markDomainVerifiedActive, verifyDomain } from "./domain.service";
import { domainExecution } from "./domain-execution";

/** Explicit projection: the DB row contains private ACME order material. */
export function publicDnsChallenge(row: DomainDnsChallenge): PublicChallenge {
  return {
    id: row.id,
    domainId: row.domainId,
    mode: row.mode,
    status: row.status,
    record:
      row.recordName && row.recordValue
        ? { type: "TXT", name: row.recordName, value: row.recordValue }
        : null,
    expiresAt: row.expiresAt.toISOString(),
    logs: row.logs,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function eligibleDomain(ctx: ExecutionContext, id: string) {
  const domain = await getDomain(ctx, id);
  if (!domain.projectId) throw new NotFoundError("Project domain", id);
  if (tlsIssuedElsewhere(domain))
    throw new ValidationError(
      "This domain's HTTPS is managed externally. A DNS certificate challenge is not needed.",
    );
  if (!isWildcardHostname(domain.hostname) && domain.sslChallenge !== "dns-01") {
    throw new ValidationError(
      "This domain uses HTTP verification. DNS challenges are for wildcard or DNS-01 domains.",
    );
  }
  const project = await repos.project.findById(domain.projectId);
  if (
    !project?.activeDeploymentId ||
    project.disabledAt ||
    project.deletedAt ||
    project.deletionInProgress ||
    domain.status === "removing"
  ) {
    throw new ValidationError(
      "Deploy and enable the project before setting up its HTTPS certificate.",
    );
  }
  const deployment = await findActiveDeployment(project);
  if (!deployment)
    throw new ValidationError(
      "The project has no current serving deployment. Deploy it before setting up HTTPS.",
    );
  if (
    resolveEffectiveTarget(platform().target, (deployment.meta ?? {}) as DeploymentMeta) === "cloud"
  ) {
    throw new ValidationError(
      "This deployment's HTTPS is managed by its cloud edge. Use domain verification instead of a local DNS certificate challenge.",
    );
  }
  if (domain.serviceId) {
    const service = await repos.service.findById(domain.serviceId);
    if (!service?.enabled || !service.exposed)
      throw new ValidationError("Enable the service and its public route before setting up HTTPS.");
  }
  return domain;
}

export async function getDnsChallenge(ctx: ExecutionContext, id: string) {
  await getDomain(ctx, id);
  await repos.domainDnsChallenge.expire(id);
  const row = await repos.domainDnsChallenge.find(id);
  return row ? publicDnsChallenge(row) : null;
}

/** Starts only after an atomic claim. Browser retries and another API replica
 * return the same pending attempt instead of opening a second ACME order. */
export async function startDnsChallenge(
  ctx: ExecutionContext,
  id: string,
  input: StartDomainDnsChallenge,
) {
  await eligibleDomain(ctx, id);
  await repos.domainDnsChallenge.expire(id);
  const { row, claimed } = await repos.domainDnsChallenge.begin(id, input.mode);
  if (claimed) void trackBackgroundWork(runDnsChallenge(ctx, row, "prepare", input.force));
  return publicDnsChallenge(row);
}

export async function checkDnsChallenge(ctx: ExecutionContext, id: string, attemptId: string) {
  await eligibleDomain(ctx, id);
  await repos.domainDnsChallenge.expire(id);
  const current = await repos.domainDnsChallenge.find(id);
  if (!current || current.id !== attemptId)
    throw new ConflictError(
      "The TXT challenge changed. Refresh the domain details before checking it.",
    );
  const row = await repos.domainDnsChallenge.claimCheck(id, attemptId);
  if (row) void trackBackgroundWork(runDnsChallenge(ctx, row, "check"));
  return publicDnsChallenge(row ?? current);
}

export async function cancelDnsChallenge(ctx: ExecutionContext, id: string, attemptId: string) {
  await getDomain(ctx, id);
  const current = await repos.domainDnsChallenge.find(id);
  if (!current || current.id !== attemptId)
    throw new ConflictError(
      "The TXT challenge changed. Refresh the domain details before cancelling it.",
    );
  if (current.mode === "automatic" && ["preparing", "installing"].includes(current.status)) {
    throw new ConflictError(
      "Automatic certificate verification is already running. Wait for its result before changing the setup method.",
    );
  }
  if (current.status === "installing")
    throw new ConflictError("The certificate is being installed. Wait for installation to finish.");
  const row = await repos.domainDnsChallenge.cancel(id, attemptId);
  return publicDnsChallenge(row ?? current);
}

/** Check exact TXT content, including DNS libraries' split string chunks. ACME
 * remains the final ownership authority; this avoids consuming a failed
 * authorization simply because the person has not published the record yet. */
export async function dnsChallengeVisible(name: string, value: string): Promise<boolean> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  try {
    return (await resolver.resolveTxt(name)).some((parts) => parts.join("") === value);
  } catch (error) {
    if (["ENODATA", "ENOTFOUND"].includes((error as NodeJS.ErrnoException).code ?? ""))
      return false;
    throw new Error(
      `Could not check the TXT record: ${safeErrorMessage(error)}. Retry when DNS is reachable.`,
    );
  }
}

async function runDnsChallenge(
  ctx: ExecutionContext,
  row: DomainDnsChallenge,
  action: "prepare" | "check",
  force = false,
) {
  const repository = repos.domainDnsChallenge;
  const lease = row.leaseId!;
  let logs: Promise<unknown> = Promise.resolve();
  const log = (message: string) => {
    logs = logs.then(() => repository.log(row.domainId, lease, message)).catch(() => undefined);
  };
  let lostLease = false;
  let heartbeat: Promise<unknown> = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        const current = await repository.heartbeat(row.domainId, lease);
        if (!current) lostLease = true;
      })
      .catch(() => {
        lostLease = true;
      });
  }, 15_000);
  timer.unref();
  const assertOwned = async () => {
    const current = await repository.find(row.domainId);
    if (
      lostLease ||
      current?.leaseId !== lease ||
      current.status === "cancelling" ||
      !current.leaseExpiresAt ||
      current.leaseExpiresAt.getTime() <= Date.now() ||
      current.expiresAt.getTime() <= Date.now()
    ) {
      throw new ConflictError("Certificate setup was cancelled or interrupted.");
    }
    await authorization.authorize(
      { ...ctx, scopeMode: "fixed" },
      { resourceType: "domain", resourceId: row.domainId, action: "write" },
    );
    await eligibleDomain(ctx, row.domainId);
    await domainExecution(ctx, row.domainId);
  };
  const finish = async (
    status: "completed" | "waiting" | "failed" | "cancelled",
    error: string | null = null,
  ) => {
    await logs;
    await repository.updateOwned(row.domainId, lease, { status, error }, true);
  };
  try {
    await assertOwned();
    const domain = await eligibleDomain(ctx, row.domainId);
    if (row.mode === "automatic") {
      // Certbot is already bounded by its own challenge lifecycle. It must be
      // allowed to settle once started, just like the existing Verify stream.
      if (!(await repository.updateOwned(row.domainId, lease, { status: "installing" }))) return;
      log("Verifying DNS and HTTPS through the connected DNS provider…");
      const result = await verifyDomain(ctx, row.domainId, { force, recheck: true, onLog: log });
      log(
        result.message ??
          (result.verified ? "HTTPS is ready." : "Certificate verification failed."),
      );
      await finish(
        result.verified ? "completed" : "failed",
        result.verified ? null : (result.message ?? "Certificate verification failed."),
      );
      return;
    }
    if (action === "prepare") {
      // Let any already-running automatic issuance settle, then recheck. The
      // lock is released before waiting for TXT or taking a runtime mutation.
      const prepared = await createProvisionLock(sslIssueLockKey(domain.hostname)).run(async () => {
        await assertOwned();
        if (!force) {
          log("Checking for an existing certificate on the deployment server…");
          const cert = await verifyExistingCert(domain.hostname, { projectId: domain.projectId! });
          if (
            cert.verified &&
            Date.parse(cert.expiresAt) >
              Date.now() + SYSTEM.DOMAINS.SSL_RENEW_BEFORE_DAYS * 86_400_000
          ) {
            return null;
          }
        }
        log("Preparing a DNS-01 certificate order…");
        return withDomainDnsCertificateProvider(
          domain.hostname,
          domain.projectId!,
          async (provider) => {
            const account = await repository.account(
              ctx.organizationId,
              provider.directoryUrl,
              encryptSecretField(await provider.createAccountKey())!,
            );
            await assertOwned();
            const result = await provider.prepare(
              domain.hostname,
              decryptSecretField(account.keyEnc)!,
            );
            return { result, accountId: account.id };
          },
        );
      });
      await assertOwned();
      if (!prepared) {
        const result = await verifyDomain(ctx, row.domainId, { recheck: true });
        if (!result.verified)
          throw new Error(
            result.message ?? "The existing certificate could not be confirmed. Retry setup.",
          );
        log("A valid certificate is already installed. No TXT challenge is needed.");
        await finish("completed");
        return;
      }
      log(
        "Add the TXT record below, then check it here. You can leave this page and return to the same challenge.",
      );
      await logs;
      await repository.updateOwned(
        row.domainId,
        lease,
        {
          status: "waiting",
          recordName: prepared.result.record.name,
          recordValue: prepared.result.record.value,
          expiresAt: new Date(prepared.result.expiresAt),
          orderEnc: encryptSecretField(prepared.result.state),
          accountId: prepared.accountId,
        },
        true,
      );
      return;
    }
    if (!row.recordName || !row.recordValue || !row.orderEnc || !row.accountId)
      throw new Error("The saved challenge is incomplete. Cancel it and start again.");
    log(`Checking TXT at ${row.recordName}…`);
    if (!(await dnsChallengeVisible(row.recordName, row.recordValue))) {
      log(
        "The expected TXT value is not visible yet. Check the record name and value, allow DNS to propagate, then check again.",
      );
      await finish(
        "waiting",
        "The TXT record is not visible yet. Check its name and value, wait for DNS propagation, then retry.",
      );
      return;
    }
    await assertOwned();
    const account = await repository.accountById(ctx.organizationId, row.accountId);
    if (!account)
      throw new Error(
        "The certificate account is unavailable. Cancel this challenge and start again.",
      );
    log("TXT found. Asking the certificate authority to validate ownership and issue HTTPS…");
    const certificate = await withDomainDnsCertificateProvider(
      domain.hostname,
      domain.projectId!,
      (provider) =>
        provider.complete(
          domain.hostname,
          decryptSecretField(account.keyEnc)!,
          decryptSecretField(row.orderEnc)!,
        ),
    );
    await assertOwned();
    if (!(await repository.updateOwned(row.domainId, lease, { status: "installing" }))) return;
    log("Installing the certificate on the current deployment server…");
    const installed = await installDomainCert(domain.hostname, certificate, {
      projectId: domain.projectId!,
      allowUnverified: true,
      beforeInstall: assertOwned,
      onInstalled: async (current, result) => {
        await assertOwned();
        await markDomainVerifiedActive(current, current.id, result);
      },
    });
    if (!installed.verified)
      throw new Error(
        "The certificate could not be verified after installation. Check the server and retry.",
      );
    log(
      "HTTPS is ready. You may remove this TXT value. Manual renewal requires a new TXT challenge before the certificate expires.",
    );
    await finish("completed");
  } catch (error) {
    const current = await repository.find(row.domainId).catch(() => undefined);
    if (current?.leaseId !== lease) return;
    if (current.status === "cancelling") {
      log("Certificate setup cancelled. You may remove this attempt's TXT value.");
      await finish("cancelled");
    } else {
      const message = safeErrorMessage(error);
      log(message);
      // An ACME/network/install failure can happen after issuance. Keep the
      // same CSR/key/order for a retry instead of creating another certificate.
      await finish(action === "check" ? "waiting" : "failed", message);
    }
  } finally {
    clearInterval(timer);
    await heartbeat;
    await logs;
    // Cancellation may have won between the final ownership check and save.
    const current = await repository.find(row.domainId).catch(() => undefined);
    if (current?.leaseId === lease && current.status === "cancelling") await finish("cancelled");
  }
}
