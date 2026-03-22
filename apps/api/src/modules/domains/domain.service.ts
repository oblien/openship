/**
 * Domain service — custom domains, DNS verification, SSL certificates.
 *
 * Cloud mode  → CNAME (target from Oblien) + TXT (verification hash)
 * Self-hosted → A record (server IP)       + TXT (verification hash)
 *
 * verifyDomain only checks DNS. SSL & routing are separate concerns.
 */

import { createHmac } from "node:crypto";
import dns from "node:dns/promises";
import { repos, type Domain, type Project } from "@repo/db";
import { NotFoundError, ConflictError, ForbiddenError } from "@repo/core";
import { platform } from "../../lib/controller-helpers";
import { manageDomainSsl } from "../../lib/domain-ssl";
import { env } from "../../config/env";
import { resolveProjectServerHost } from "../../lib/server-target";
import type { TAddDomainBody } from "./domain.schema";
import type { CloudRuntime } from "@repo/adapters";

// ─── Token ───────────────────────────────────────────────────────────────────

/**
 * Deterministic verification token for a hostname.
 * HMAC-SHA256(hostname, secret) → hex prefix. Same input always produces
 * the same output so preview and stored tokens match.
 */
function generateToken(hostname: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(hostname.toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

// ─── List ────────────────────────────────────────────────────────────────────

export async function listDomains(projectId: string, userId: string) {
  const project = await repos.project.findById(projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", projectId);
  }
  return repos.domain.listByProject(projectId);
}

// ─── Add ─────────────────────────────────────────────────────────────────────

export async function addDomain(userId: string, data: TAddDomainBody) {
  const project = await repos.project.findById(data.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Project", data.projectId);
  }

  const existing = await repos.domain.findByHostname(data.hostname);
  if (existing) {
    throw new ConflictError(`Domain "${data.hostname}" is already in use`);
  }

  const token = generateToken(data.hostname);

  const domain = await repos.domain.create({
    projectId: data.projectId,
    hostname: data.hostname,
    isPrimary: data.isPrimary ?? false,
    verificationToken: token,
  });

  if (data.isPrimary) {
    await repos.domain.setPrimary(data.projectId, domain.id);
  }

  const records = await buildRecords(domain.hostname, token, project);
  return { domain, records };
}

// ─── Preview records (no auth, no DB write) ──────────────────────────────────

export async function previewRecords(hostname: string) {
  const token = generateToken(hostname);
  return buildRecords(hostname, token);
}

// ─── Get DNS records (existing domain) ───────────────────────────────────────

export async function getDomainRecords(domainId: string, userId: string) {
  const { domain, project } = await getDomainWithAuth(domainId, userId);
  const token = domain.verificationToken ?? generateToken(domain.hostname);
  return buildRecords(domain.hostname, token, project);
}

// ─── Verify ──────────────────────────────────────────────────────────────────
//
// Only checks DNS records. Does NOT provision SSL or register routes.

export async function verifyDomain(domainId: string, userId: string) {
  const { domain, project } = await getDomainWithAuth(domainId, userId);

  if (domain.verified) {
    return { verified: true, cnameVerified: true, txtVerified: true, message: "Already verified" };
  }

  const { target } = platform();
  const token = domain.verificationToken ?? generateToken(domain.hostname);

  // 1. Routing record — cloud: CNAME via Oblien, self-hosted: A record
  const routeOk = target === "cloud"
    ? await verifyCname(domain.hostname)
    : await verifyARecord(domain.hostname, project);

  // 2. Ownership — TXT record with verification hash
  const txtOk = await verifyTxt(domain.hostname, token);

  if (routeOk && txtOk) {
    await repos.domain.markVerified(domainId);
    return { verified: true, cnameVerified: true, txtVerified: true, message: "Domain verified" };
  }

  return {
    verified: false,
    cnameVerified: routeOk,
    txtVerified: txtOk,
    message: verifyMessage(domain.hostname, token, routeOk, txtOk, target),
  };
}

// ─── Remove ──────────────────────────────────────────────────────────────────

export async function removeDomain(domainId: string, userId: string) {
  const { domain } = await getDomainWithAuth(domainId, userId);

  try {
    const { routing } = platform();
    await routing.removeRoute(domain.hostname);
  } catch (err) {
    console.error(`[DOMAIN] Failed to remove route for ${domain.hostname}:`, err);
  }

  await repos.domain.remove(domainId);
}

// ─── SSL ─────────────────────────────────────────────────────────────────────

export async function renewDomainSsl(domainId: string, userId: string) {
  const { domain } = await getDomainWithAuth(domainId, userId);

  const result = await manageDomainSsl(domain.hostname, {
    action: "renew",
    userId,
  });

  return {
    domain: domain.hostname,
    sslStatus: result.expiresAt ? "active" : "provisioning",
    expiresAt: result.expiresAt,
    issuer: result.issuer,
  };
}

export { renewExpiringCerts } from "../../lib/ssl-scheduler";

export async function renewUserCerts(userId: string) {
  const projects = await repos.project.listByUser(userId, { page: 1, perPage: 1000 });
  const results: Array<{ domain: string; status: string; error?: string }> = [];

  for (const p of projects.rows) {
    const domains = await repos.domain.listByProject(p.id);
    for (const d of domains) {
      if (d.sslStatus !== "active" || !d.sslExpiresAt) continue;
      const daysLeft = (new Date(d.sslExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      if (daysLeft > 14) continue;
      try {
        await renewDomainSsl(d.id, userId);
        results.push({ domain: d.hostname, status: "renewed" });
      } catch (err) {
        results.push({ domain: d.hostname, status: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  return { renewed: results.filter((r) => r.status === "renewed").length, results };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getDomainWithAuth(domainId: string, userId: string): Promise<{ domain: Domain; project: Project }> {
  const domain = await repos.domain.findById(domainId);
  if (!domain) throw new NotFoundError("Domain", domainId);

  const project = await repos.project.findById(domain.projectId);
  if (!project || project.userId !== userId) {
    throw new NotFoundError("Domain", domainId);
  }

  return { domain, project };
}

// ── DNS resolution (Google DNS-over-HTTPS → node:dns fallback) ───────────────

const GOOGLE_DNS = "https://dns.google/resolve";

interface GoogleDnsAnswer {
  name: string;
  type: number;
  data: string;
}

/** Query Google public DNS API. Falls back to node:dns on failure. */
async function resolveRecords(
  name: string,
  type: "A" | "CNAME" | "TXT",
): Promise<string[]> {
  const rrtype: Record<string, number> = { A: 1, CNAME: 5, TXT: 16 };

  try {
    const url = `${GOOGLE_DNS}?name=${encodeURIComponent(name)}&type=${rrtype[type]}`;
    const res = await fetch(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    });

    if (res.ok) {
      const json = (await res.json()) as { Answer?: GoogleDnsAnswer[] };
      return (json.Answer ?? []).map((a) => a.data.replace(/^"|"$/g, ""));
    }
  } catch { /* Google DNS unreachable */ }

  // Fallback — local resolver
  try {
    switch (type) {
      case "A":
        return await dns.resolve4(name);
      case "CNAME":
        return await dns.resolveCname(name);
      case "TXT": {
        const rows = await dns.resolveTxt(name);
        return rows.flat();
      }
    }
  } catch { /* no records */ }

  return [];
}

// ── DNS checks ───────────────────────────────────────────────────────────────

/** Cloud: ask Oblien if the CNAME is pointing correctly. */
async function verifyCname(hostname: string): Promise<boolean> {
  const { runtime } = platform();
  try {
    const cloud = runtime as CloudRuntime;
    const result = await cloud.verifyDomain(hostname);
    return result.cname;
  } catch {
    return false;
  }
}

/** Self-hosted: check if an A record resolves to our server IP. */
async function verifyARecord(hostname: string, project?: Project): Promise<boolean> {
  const serverIp = await resolveProjectServerHost(project);
  if (!serverIp) return false;

  const records = await resolveRecords(hostname, "A");
  return records.includes(serverIp);
}

/** Check _openship-challenge.{hostname} TXT record for verification token. */
async function verifyTxt(hostname: string, token: string): Promise<boolean> {
  const records = await resolveRecords(`_openship-challenge.${hostname}`, "TXT");
  return records.some((v) => v === token);
}

// ── Record generation ────────────────────────────────────────────────────────

type DnsRecord =
  | { type: "CNAME"; host: string; value: string }
  | { type: "A"; host: string; value: string }
  | { type: "TXT"; host: string; value: string };

/**
 * Build the DNS records the user needs to add.
 *
 * Cloud       → CNAME @ → <target from Oblien>
 * Self-hosted → A     @ → <server public IP>
 * Both        → TXT _openship-challenge → <verification hash>
 */
async function buildRecords(
  hostname: string,
  token: string,
  project?: Project,
): Promise<{ mode: "cloud" | "selfhosted"; records: DnsRecord[] }> {
  const { target, runtime } = platform();

  const txt: DnsRecord = { type: "TXT", host: "_openship-challenge", value: token };

  if (target === "cloud") {
    let cnameTarget: string | null = null;
    try {
      const cloud = runtime as CloudRuntime;
      const result = await cloud.verifyDomain(hostname);
      cnameTarget = result.requiredRecords.cname.target;
    } catch { /* Oblien unreachable */ }

    return {
      mode: "cloud",
      records: [{ type: "CNAME", host: "@", value: cnameTarget ?? "" }, txt],
    };
  }

  // Self-hosted — A record
  const serverIp = await resolveProjectServerHost(project);
  return {
    mode: "selfhosted",
    records: [{ type: "A", host: "@", value: serverIp ?? "" }, txt],
  };
}

/** Build a human-readable verification failure message. */
function verifyMessage(
  hostname: string,
  token: string,
  routeOk: boolean,
  txtOk: boolean,
  target: string,
): string {
  const parts: string[] = [];

  if (!routeOk) {
    parts.push(
      target === "cloud"
        ? `CNAME record not found for ${hostname}`
        : `A record not pointing to server for ${hostname}`,
    );
  }

  if (!txtOk) {
    parts.push(`TXT record _openship-challenge.${hostname} must equal "${token}"`);
  }

  return parts.join(". ");
}
