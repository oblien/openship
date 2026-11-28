// Optional local SaaS worker for the two inboxes in apps/email/dev/compose.yml.
// The Cloud API still handles authentication, service ownership, grants and routing.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const serverId = "local-mail-sample";
const domain = "openship.test";
const createdAt = "2026-01-10T10:00:00Z";
const mailboxes = [["alex", "Alex"], ["sam", "Sam Taylor"]].map(([local, name]) => ({
  username: local + "@" + domain, name, domain, quotaMB: 2048,
  storagebasedirectory: "/var/vmail", storagenode: "vmail1", maildir: domain + "/" + local + "/",
  active: true, isAdmin: false, isGlobalAdmin: false, isPlatform: false,
  createdAt, passwordLastChange: createdAt,
}));
const domainInfo = {
  domain, description: "Local sample inboxes", mailboxes: mailboxes.length, aliases: 0,
  maxMailboxes: 0, maxAliases: 0, defaultQuotaMB: 2048, active: true, createdAt,
};

const exec = promisify(execFile);
async function sampleInboxCounts() {
  const fallback = mailboxes.map(({ username }) => ({ username, messages: null }));
  let accounts = fallback;
  try {
    const context = (await readFile(new URL("../../email/.dev-mail/docker-context", import.meta.url), "utf8")).trim();
    const { stdout } = await exec("docker", ["--context", context, "compose", "-f",
      fileURLToPath(new URL("../../email/dev/compose.yml", import.meta.url)), "exec", "-T",
      "api", "bun", "/app/dev/inbox-counts.ts"], { timeout: 9000 });
    const counts = JSON.parse(stdout);
    accounts = fallback.map(({ username }) => {
      const n = counts.find(box => box.username === username)?.messages;
      return { username, messages: Number.isSafeInteger(n) && n >= 0 ? n : null };
    });
  } catch { /* The independent sample inbox may be stopped. Keep its counts unknown. */ }
  const total = accounts.every(box => box.messages !== null) ? accounts.reduce((n, box) => n + box.messages, 0) : null;
  return { total, domains: [{ domain, messages: total, mailboxes: accounts }] };
}

export async function startLocalMailSample() {
  const tenant = process.env.OPENSHIP_LOCAL_MAIL_SAMPLE_TENANT;
  if (!tenant || process.env.OPENSHIP_TARGET !== "local-saas" || process.env.NODE_ENV !== "development") return;
  const engine = JSON.parse(process.env.OPENSHIP_MAIL_ENGINES ?? "[]").find(item => item.serverId === serverId);
  if (!/^openship-mail-[a-f0-9]{32}$/.test(tenant) || !engine?.token || !engine.shared)
    throw new Error("The local mail sample requires a tenant and a shared local-mail-sample engine.");
  const origin = new URL(engine.origin);
  if (origin.hostname !== "127.0.0.1" || origin.protocol !== "http:" || !origin.port)
    throw new Error("The local mail sample must listen on a loopback port.");

  const admin = "/api/mail/admin/" + serverId;
  const tenantAdmin = "/api/mail/tenants/" + tenant + "/admin/" + serverId;
  const accessToken = "opsh_mail_" + randomBytes(32).toString("base64url");
  let serviceId;
  let inboxSnapshot;
  let nextRead = 0;
  const server = createServer(async (req, res) => {
    function json(status, data) {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    }
    const { pathname, searchParams } = new URL(req.url, origin);
    const scoped = pathname.startsWith(tenantAdmin + "/");
    if (req.headers.authorization !== "Bearer " + (scoped ? accessToken : engine.token) ||
        (scoped && (!serviceId || req.headers["x-openship-mail-service"] !== serviceId)))
      return json(401, { error: "Unauthorized" });
    if (req.method === "POST" && pathname === admin + "/tenant-access") {
      let body = "";
      for await (const chunk of req) body += chunk;
      let input;
      try { input = JSON.parse(body); } catch { return json(400, { error: "Invalid access request" }); }
      if (input.namespace !== tenant || !/^managed-mail-[a-zA-Z0-9_-]{1,96}$/.test(input.serviceId) ||
          (serviceId && serviceId !== input.serviceId)) return json(403, { error: "Unknown service" });
      serviceId = input.serviceId;
      return json(200, { token: accessToken });
    }
    if (req.method === "GET" && pathname === "/api/mail/status" && searchParams.get("serverId") === serverId)
      return json(200, {
        serverId, active: false, steps: [], finishedAt: createdAt, domain: engine.hostname.slice(5),
        engine: { flavor: "container", running: true },
        webmail: { installed: true, projectId: serverId, url: engine.webmailUrl },
      });
    if (req.method === "PUT" && pathname === admin + "/webmail/hosting") return json(200, { bound: true });
    if (!pathname.startsWith(tenantAdmin + "/")) return json(404, { error: "Unknown mail tenant or service" });
    if (req.method !== "GET") return json(405, { error: "Sample mailbox data is read-only" });
    const path = pathname.slice(tenantAdmin.length);
    if (path === "/stats") {
      const includeInbox = searchParams.get("inbox") === "1";
      if (includeInbox && Date.now() >= nextRead) {
        nextRead = Date.now() + 30_000;
        inboxSnapshot = sampleInboxCounts();
      }
      return json(200, {
      ...(includeInbox && { inbox: await inboxSnapshot }),
      domains: { total: 1, active: 1 }, mailboxes: { total: mailboxes.length, active: mailboxes.length },
      aliases: { total: 0 }, storageBytes: 32768, messages: 12,
      });
    }
    if (path === "/domains") return json(200, { domains: [domainInfo] });
    if (path === "/domains/" + domain) return json(200, { domain: domainInfo });
    if (path === "/domains-dns/pending") return json(200, { pending: [] });
    if (path === "/mailboxes" && searchParams.get("domain") === domain) return json(200, { mailboxes, readOnly: true });
    if (path === "/aliases" && searchParams.get("domain") === domain) return json(200, { aliases: [] });
    if (path === "/domains/" + domain + "/dns") return json(200, {
      domain, createdAt, acknowledgedAt: createdAt,
      records: {
        mx: { type: "MX", name: domain, priority: 10, value: engine.hostname },
        spf: { type: "TXT", name: domain, value: "v=spf1 -all" },
        dkim: { type: "TXT", name: "sample._domainkey." + domain, value: "v=DKIM1; p=" },
        dmarc: { type: "TXT", name: "_dmarc." + domain, value: "v=DMARC1; p=reject" },
      },
    });
    return json(404, { error: "Unknown sample resource" });
  });
  await new Promise((ready, reject) => {
    server.once("error", reject);
    server.listen(Number(origin.port), origin.hostname, ready);
  });
  return server;
}

// When preloaded from the private .env.local-saas, only the API process owns
// the worker. CLI commands and child processes inherit no additional listener.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(new URL("../src/index.ts", import.meta.url)))
  await startLocalMailSample();
