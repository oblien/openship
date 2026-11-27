import { readFile } from "node:fs/promises";
import { mailDatabaseTenant } from "@repo/platform/engine/modules/mail/tenant-session";
import "../mail/_setup-env";
import { PGlite } from "@electric-sql/pglite";
import { repos } from "@repo/db";
import { hashPatToken } from "@repo/platform/engine/lib/pat";
import { updateMailbox, hardDeleteMailbox } from "@repo/platform/engine/modules/mail/admin/mailboxes.service";
import { countDomainDependents, getDomain, updateDomain, deleteDomain } from "@repo/platform/engine/modules/mail/admin/domains.service";
import { q } from "@repo/platform/engine/modules/mail/admin/psql-runner";
import { createAlias, deleteAlias, getAlias, listAliases, updateAliasActive } from "../../../src/modules/mail/admin/aliases.service";
import { Hono } from "hono";
import { afterAll, expect, it, vi } from "vitest";
import { seedOwner, seedServer } from "../jobs/_harness";
import { mailAccountRoutes } from "../../../src/modules/mail/accounts.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { initializeSharedDomains } from "@repo/platform/engine/modules/mail/admin/tenant-domains";

// Exercise the worker's real handlers, permissions, SQL and aggregates. Only
// replace the network hop that normally invokes psql over the host executor.
const vmail = new PGlite();
const beforeWrite = vi.hoisted(() => vi.fn(async () => {}));
const runMailCommand = vi.hoisted(() => vi.fn());
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withExecutor: async (_server: string, run: (executor: object) => unknown) => run({}) },
}));
vi.mock("@repo/platform/engine/modules/mail/mail-state", async (original) => ({
  ...(await original<object>()),
  readState: async () => ({ domain: "host.test" }),
}));

vi.mock("@repo/platform/engine/modules/mail/mail-engine", async (original) => ({
  ...(await original<object>()),
  runMailCommand,
  runMailSql: async (_server: string, sql: string) => {
    if (sql.startsWith("BEGIN;")) await beforeWrite();
    const tenant = mailDatabaseTenant();
    let result;
    if (tenant) {
      try {
        [, result] = await vmail.exec(`SET SESSION AUTHORIZATION "${tenant}"; ${sql}; SET SESSION AUTHORIZATION postgres`);
      } catch (error) {
        await vmail.exec("ROLLBACK; SET SESSION AUTHORIZATION postgres");
        throw error;
      }
    } else {
      [result] = await vmail.exec(sql);
    }
    return JSON.stringify(result?.rows[0] && Object.values(result.rows[0])[0]);
  },
}));
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  resolveTxt: async () => [["openship-mail=managed-mail-second"]],
}));
vi.mock("../../../src/modules/mail/webmail/sending-settings", () => ({
  bindWebmailHosting: async () => ({ bound: true }),
}));
afterAll(() => vmail.close());

it("round-trips mail database text under both PostgreSQL string settings", async () => {
  for (const setting of ["on", "off"]) {
    await vmail.transaction(async (tx) => {
      await tx.exec(`SET LOCAL standard_conforming_strings = ${setting}`);
      for (const value of ["", "D'Arcy", "Studio\\North", "Studio\\'s draft", "مرحبا\nTeam"]) {
        const result = await tx.query(`SELECT ${q(value)} AS value`);
        expect(result.rows).toEqual([{ value }]);
      }
    });
  }
  expect(() => q("mail\0label")).toThrow("null character");
});

it("scopes lists, stats, address operations and ID-only alias mutations inside one worker database", async () => {
  const owner = await seedOwner({ instanceAdmin: true });
  const server = await seedServer(owner.orgId);
  const a = "openship-mail-" + "a".repeat(32),
    b = "openship-mail-" + "b".repeat(32);
  await vmail.exec(await readFile(new URL("../../../../email/engine/samples/iredmail/iredmail.pgsql", import.meta.url), "utf8"));
  await vmail.exec(`
    CREATE ROLE vmail;
    CREATE ROLE vmailadmin;
    INSERT INTO domain (domain) VALUES ('host.test');
  `);
  await initializeSharedDomains(server, "host.test");
  await vmail.exec(`
    INSERT INTO domain (domain) VALUES ('first.test'), ('other.test');
    INSERT INTO openship_domain_owner VALUES ('first.test','${a}'), ('other.test','${b}');
    INSERT INTO mailbox (username,domain,active,quota,storagebasedirectory,storagenode,maildir)
      VALUES ('me@first.test','first.test',1,2048,'/var/vmail','vmail1','first.test/me/'),
             ('me@other.test','other.test',1,2048,'/var/vmail','vmail1','other.test/me/');
    INSERT INTO used_quota (username,bytes,messages) VALUES ('me@first.test',100,3),('me@other.test',200,5);
    INSERT INTO forwardings (address, forwarding, domain, dest_domain, is_alias, active)
      VALUES ('alias@other.test','me@other.test','other.test','other.test',1,1);
  `);
  const app = new Hono().onError(handleApiError).route("/api/mail", mailAccountRoutes);
  const services = { [a]: "managed-mail-first", [b]: "managed-mail-second" };
  const issue = (namespace: string, serviceId: string) => app.request(`/api/mail/admin/${server}/tenant-access`, {
    method: "POST", headers: { ...owner.auth, "content-type": "application/json" },
    body: JSON.stringify({ namespace, serviceId, imapHost: "mail.host.test" }),
  });
  const tokens: Record<string, string> = {};
  for (const ns of [a, b]) {
    const reply = await issue(ns, services[ns]!);
    expect(reply.status).toBe(200);
    tokens[ns] = (await reply.json()).token;
  }
  expect((await issue(a, services[b]!)).status).toBe(409);
  expect((await issue("openship-mail-" + "c".repeat(32), services[a]!)).status).toBe(409);
  const call = (tenant: string, path: string, method = "GET", body?: object, credential = tokens[tenant], service = services[tenant]) =>
    app.request(`/api/mail/tenants/${tenant}/admin/${server}/${path}`, {
      method,
      headers: { authorization: "Bearer " + credential, "x-openship-mail-service": service!, "content-type": "application/json" },
      body: body && JSON.stringify(body),
    });
  expect((await call(b, "domains", "GET", undefined, tokens[a])).status).toBe(401);
  expect((await call(a, "domains", "GET", undefined, tokens[a], services[b])).status).toBe(401);
  expect((await call(a, "domains", "GET", undefined, owner.token)).status).toBe(401);
  expect((await app.request(`/api/mail/admin/${server}/domains`, { headers: { authorization: "Bearer " + tokens[a] } })).status).toBe(401);
  expect((await call(a, "domains", "POST", { domain: "unclaimed.test" })).status).toBe(409);
  expect((await call(a, "domains/first.test/dns/plan")).status).toBe(404);
  for (const [ns, domain, bytes] of [
    [a, "first.test", 100],
    [b, "other.test", 200],
  ] as const) {
    const list = await call(ns, "domains");
    expect(list.status).toBe(200);
    expect((await list.json()).domains.map((row: { domain: string }) => row.domain)).toEqual([
      domain,
    ]);
    expect(await (await call(ns, "stats")).json()).toMatchObject({
      domains: { total: 1 },
      mailboxes: { total: 1 },
      storageBytes: bytes,
    });
  }
  expect(runMailCommand).not.toHaveBeenCalled(); // Ordinary stats skip the Dovecot read.
  runMailCommand.mockImplementation(async (_server, build) => {
    const command = build("container");
    expect(command).toContain(mailDatabaseTenant()!);
    expect(command).not.toContain("-U postgres");
    expect(command).toContain("openship_domain_owner");
    expect(command).toContain("mailbox status -F");
    // Include an unexpected user to check the final result against the SQL roster.
    return { output: "Username\tmailbox\tmessages\nme@first.test\tINBOX\t2\nme@other.test\tINBOX\t4" };
  });
  const stats = () => call(a, "stats?inbox=1").then(r => r.json());
  const [first, same] = await Promise.all([stats(), stats()]);
  expect(first.messages).toBe(3); // Includes archived messages in the quota counter.
  expect(first.inbox).toEqual({ total: 2, domains: [{ domain: "first.test", messages: 2,
    mailboxes: [{ username: "me@first.test", messages: 2 }] }] });
  expect(same.inbox).toEqual(first.inbox);
  expect(runMailCommand).toHaveBeenCalledTimes(1);
  expect((await (await call(b, "stats?inbox=1")).json()).inbox.total).toBe(4);
  await vmail.exec("INSERT INTO mailbox (username,domain,active,storagebasedirectory,storagenode,maildir) VALUES ('new@first.test','first.test',1,'/var/vmail','vmail1','first.test/new/')");
  expect((await stats()).inbox).toMatchObject({ total: null, domains: [{ messages: null, mailboxes: [
    { username: "me@first.test", messages: 2 }, { username: "new@first.test", messages: null },
  ] }] });
  expect(runMailCommand).toHaveBeenCalledTimes(3);
  // The same addresses after a delete/recreate must get a fresh Dovecot snapshot.
  await vmail.exec("DELETE FROM mailbox WHERE username='new@first.test'");
  await vmail.exec("INSERT INTO mailbox (username,domain,active,maildir) VALUES ('new@first.test','first.test',1,'first.test/new-home/')");
  await stats();
  expect(runMailCommand).toHaveBeenCalledTimes(4);
  for (const path of [
    "domains/other.test",
    "domains/other.test/dns",
    "mailboxes/me@other.test",
    "aliases?domain=other.test",
    "dns-scan?domain=other.test",
  ]) {
    expect((await call(a, path)).status).toBe(404);
  }
  expect((await call(a, "aliases/1", "DELETE")).status).toBe(404);
  expect((await call(a, "domains/other.test", "DELETE")).status).toBe(404);
  expect((await call(a, "mailboxes/me@other.test", "DELETE")).status).toBe(404);
  expect((await call(a, "domains/host.test")).status).toBe(404);
  expect(await (await call(b, "aliases?domain=other.test")).json()).toMatchObject({
    aliases: [{ id: 1 }],
  });

  // Exercise the data boundary independently of the route guard.
  expect(await getDomain(server, "other.test", a)).toBeNull();
  expect(await listAliases(server, "other.test", a)).toEqual([]);
  expect(await getAlias(server, 1, a)).toBeNull();
  expect(await countDomainDependents(server, "other.test", a)).toEqual({ mailboxes: 0, aliases: 0 });
  await expect(updateDomain(server, "other.test", { active: false }, a)).rejects.toThrow();
  await expect(deleteDomain(server, "other.test", { cascade: true, namespace: a })).rejects.toThrow();
  await expect(updateAliasActive(server, 1, false, a)).rejects.toThrow();
  await expect(deleteAlias(server, 1, a)).rejects.toThrow();
  expect(await getDomain(server, "other.test", b)).toMatchObject({ domain: "other.test", active: true });
  expect(await getAlias(server, 1, b)).toMatchObject({ domain: "other.test", active: true });
  const alias = { domain: "first.test", localPart: "sales", isCatchAll: true, destination: "me@first.test" };
  const local = await createAlias(server, alias, a);
  await expect(createAlias(server, { ...alias, destination: "me@other.test" }, a))
    .rejects.toThrow("Mail domain ownership changed");
  await vmail.exec("ROLLBACK");
  expect(await getAlias(server, local.id, a)).toMatchObject({ forwarding: "me@first.test" });
  expect(await updateAliasActive(server, local.id, false, a)).toMatchObject({ active: false });
  await deleteAlias(server, local.id, a);
  expect(await getAlias(server, local.id, a)).toBeNull();
  expect(await updateDomain(server, "first.test", { description: "Team's mail" }, a))
    .toMatchObject({ description: "Team's mail" });

  // Only the command transport is simulated. The worker changes the same
  // mailbox row used by Dovecot and preserves the other tenant's account.
  await expect(updateMailbox(server, "me@other.test", { name: "Denied" }, a)).rejects.toThrow();
  await expect(hardDeleteMailbox(server, "me@other.test", a)).rejects.toThrow();
  const path = "mailboxes/me%40first.test";
  const replacement = { password: "replacement-password" };
  // Ownership must still hold at write time, even after a successful scoped read.
  beforeWrite.mockImplementationOnce(async () => {
    await vmail.query("UPDATE openship_domain_owner SET namespace=$1 WHERE domain='first.test'", [b]);
  });
  await expect(updateMailbox(server, "me@first.test", replacement, a)).rejects.toThrow("Mail domain ownership changed");
  // psql closes its connection on an aborted transaction. Our single in-process connection stays open.
  await vmail.exec("ROLLBACK");
  expect((await vmail.query("SELECT password FROM mailbox WHERE username='me@first.test'")).rows).toEqual([{ password: "" }]);
  await vmail.query("UPDATE openship_domain_owner SET namespace=$1 WHERE domain='first.test'", [a]);
  runMailCommand.mockResolvedValue({ output: "", flavor: "container" });
  expect((await call(b, path, "PATCH", replacement)).status).toBe(404);
  expect((await call(a, path, "PATCH", replacement)).status).toBe(200);
  const account = () => vmail.query("SELECT active, quota, password FROM mailbox WHERE username = 'me@first.test'");
  expect((await account()).rows).toEqual([{ active: 1, quota: 2048, password: expect.stringMatching(/^\{SSHA512\}/) }]);
  expect((await call(a, path, "DELETE")).status).toBe(200);
  expect((await account()).rows[0]).toMatchObject({ active: 0 });
  expect((await vmail.query("SELECT username FROM deleted_mailboxes")).rows).toEqual([{ username: "me@first.test" }]);
  expect((await call(a, path + "?hard=true", "DELETE")).status).toBe(200);
  expect((await account()).rows).toEqual([]);
  expect((await vmail.query("SELECT active, password FROM mailbox WHERE username = 'me@other.test'")).rows)
    .toEqual([{ active: 1, password: "" }]);
  const connect = (domain: string) => call(b, "domains", "POST", { domain });
  expect((await connect("first.test")).status).toBe(409);
  expect((await connect("host.test")).status).toBe(409);
  expect((await connect("new.test")).status).toBe(201);
  expect((await vmail.query("SELECT username FROM mailbox WHERE domain='new.test'")).rows).toEqual([]);
  expect((await connect("new.test")).status).toBe(409);
  expect((await call(b, "domains/new.test")).status).toBe(200);
  expect((await call(a, "domains/new.test")).status).toBe(404);
  const mailbox = { localPart: "postmaster", domain: "new.test", password: "fixture-password" };
  expect((await call(b, "mailboxes", "POST", mailbox)).status).toBe(201);
  const postmaster = await call(b, "mailboxes/postmaster%40new.test");
  expect(postmaster.status).toBe(200);
  expect(await postmaster.json()).toMatchObject({ mailbox: { isAdmin: false, isGlobalAdmin: false } });
  expect((await call(a, "mailboxes/postmaster%40new.test")).status).toBe(404);
  beforeWrite.mockRejectedValueOnce(new Error("Fixture worker diagnostic"));
  const workerFailure = await call(b, "mailboxes/postmaster%40new.test", "PATCH", replacement);
  expect(workerFailure.status).toBe(500);
  expect(await workerFailure.json()).toEqual({ error: "The mail server could not complete this operation." });
  const parent = await repos.personalAccessToken.findActiveByHash(hashPatToken(owner.token));
  await repos.personalAccessToken.revoke(parent!.id, owner.userId);
  expect((await call(a, "domains")).status).toBe(401);
});
