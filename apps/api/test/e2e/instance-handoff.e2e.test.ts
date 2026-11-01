import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { freePort, startApi, stopApi, jsonRequest, type RunningApi } from "./fixtures/instance-api";
import type { DataTransferFile } from "../../src/modules/system/data-transfer/types";

const roots: string[] = [];
const proxies: Server[] = [];
const apis: RunningApi[] = [];
const run = promisify(execFile);
const post = <T>(api: RunningApi, path: string, body: unknown = {}) =>
  jsonRequest<T>(api.baseUrl, path, { method: "POST", body: JSON.stringify(body) });
const state = (api: RunningApi) =>
  jsonRequest<{
    role: string;
    handoff: null | { id: string; status: string; error: string | null; running: boolean };
  }>(api.baseUrl, "/api/system/instance");
async function waitMove(api: RunningApi) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const value = await state(api);
    if (value.handoff?.error && !value.handoff.running)
      throw new Error(`${value.handoff.error}\n${api.logs()}`);
    if (value.handoff?.status === "complete" && !value.handoff.running) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Move did not finish: ${JSON.stringify(await state(api))}\n${api.logs()}`);
}
afterAll(async () => {
  for (const proxy of proxies) {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
  for (const api of apis) await stopApi(api);
  for (const directory of roots) await rm(directory, { recursive: true, force: true });
});

const archive = (api: RunningApi) =>
  post<DataTransferFile>(api, "/api/system/data-transfer/export");
async function createProject(api: RunningApi, name: string) {
  return (
    await post<{ data: { id: string } }>(api, "/api/projects", {
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      framework: "static",
      hasBuild: false,
      hasServer: false,
      productionMode: "static",
    })
  ).data;
}
async function pair(environment?: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "openship-instance-e2e-"));
  roots.push(directory);
  const source = await startApi({
    dbDir: join(directory, "source"),
    port: await freePort(),
    secret: "source-instance-key-000000000000000000000000",
    environment,
  });
  apis.push(source);
  const target = await startApi({
    dbDir: join(directory, "target"),
    port: await freePort(),
    secret: "target-instance-key-111111111111111111111111",
  });
  apis.push(target);
  for (const [name, api] of [
    ["source", source],
    ["target", target],
  ] as const) {
    await post(api, "/api/system/upgrade-to-auth", {
      name: `${name} owner`,
      email: `${name}@example.test`,
      password: "test-password-instance-only-938!",
    });
  }
  return { source, target };
}

/** Real HTTP transport for a dashboard's API mount, or a lost acknowledgement
 * AFTER the peer committed. The handoff and authentication handlers stay real. */
async function apiProxy(
  target: RunningApi,
  { failAction, mount = "" }: { failAction?: "prepare" | "activate"; mount?: string } = {},
) {
  let dropped = false;
  const proxy = createServer(async (req, res) => {
    if (!req.url?.startsWith(`${mount}/`)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (typeof value === "string" && !["connection", "content-length"].includes(key))
        headers.set(key, value);
    const upstream = await fetch(`${target.baseUrl}${req.url.slice(mount.length)}`, {
      method: req.method,
      headers,
      ...(body.length ? { body } : {}),
      redirect: "manual",
    });
    let content = Buffer.from(await upstream.arrayBuffer());
    if (failAction && !dropped && req.url.endsWith(`/${failAction}`) && upstream.ok) {
      dropped = true;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Simulated lost acknowledgement" }));
      return;
    }
    if (req.url?.endsWith("/activate") && upstream.ok) {
      const receipt = JSON.parse(content.toString("utf8"));
      content = Buffer.from(
        JSON.stringify({
          ...receipt,
          origin: `http://127.0.0.1:${(proxy.address() as { port: number }).port}${mount}`,
        }),
      );
    }
    const outgoing = Object.fromEntries(upstream.headers);
    delete outgoing["content-length"];
    delete outgoing["content-encoding"];
    delete outgoing["transfer-encoding"];
    res.writeHead(upstream.status, outgoing);
    res.end(Buffer.from(content));
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  proxies.push(proxy);
  return { ...target, baseUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` };
}
function viaProxy(code: string, proxy: RunningApi): string {
  // Public URLs are canonical, so changing the request Host alone must not
  // redirect credentials. Explicitly point this test's capability at the proxy.
  const offer = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  return Buffer.from(JSON.stringify({ ...offer, origin: proxy.baseUrl })).toString("base64url");
}
async function waitError(api: RunningApi) {
  for (let i = 0; i < 300; i++) {
    const s = await state(api);
    if (s.handoff?.error && !s.handoff.running) return s;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Expected an interrupted move\n${api.logs()}`);
}

it("moves a real instance, keeps its identities/secrets and leaves the source as a remote client", async () => {
  const { source, target } = await pair();
  const { data: project } = await post<{ data: { id: string } }>(source, "/api/projects", {
    name: "Handoff identity",
    slug: "handoff-identity",
    framework: "static",
    hasBuild: false,
    hasServer: false,
    productionMode: "static",
  });
  await jsonRequest(source.baseUrl, `/api/projects/${project.id}/env`, {
    method: "PATCH",
    body: JSON.stringify({
      environment: "production",
      upserts: [{ key: "PRESERVED_SECRET", value: "instance-handoff-secret-✓", isSecret: true }],
      deletes: [],
    }),
  });
  const offer = await post<{ code: string }>(target, "/api/system/instance/offer", {
    direction: "target",
  });
  await post(source, "/api/system/instance/move", { code: offer.code, confirmReplace: true });
  expect((await waitMove(source)).role).toBe("retired");
  expect((await state(target)).role).toBe("active");
  const record = await jsonRequest<{ data: { id: string } }>(
    target.baseUrl,
    `/api/projects/${project.id}`,
  );
  expect(record.data.id).toBe(project.id);
  const exported = await archive(target);
  expect(JSON.stringify(exported.secrets)).toContain("instance-handoff-secret-✓");
  expect(exported.dump.tables).not.toHaveProperty("instance_controller");
  expect(exported.dump.tables).not.toHaveProperty("instance_handoff");
  // An ordinary API read on the old Desktop reaches the active API through its
  // paired user; it does not open a second control plane.
  expect(await jsonRequest(source.baseUrl, `/api/projects/${project.id}`)).toEqual(record);
  const before = await state(source);
  await stopApi(source);
  const restarted = await startApi({
    dbDir: source.dbDir,
    port: source.port,
    secret: source.secret,
  });
  apis.push(restarted);
  expect((await state(restarted)).role).toBe(before.role);
  expect(restarted.logs()).not.toContain("[boot] backup runner:");
  // Work created while connected belongs to the remote DB, and must come back
  // with the latest state, rather than restoring Desktop's old snapshot.
  const newer = await createProject(restarted, "Created remotely");
  await post(restarted, "/api/system/instance/return", { confirmReplace: true });
  expect((await waitMove(restarted)).role).toBe("active");
  expect((await state(target)).role).toBe("retired");
  expect(
    (await jsonRequest<{ data: { id: string } }>(restarted.baseUrl, `/api/projects/${newer.id}`))
      .data.id,
  ).toBe(newer.id);
  expect(JSON.stringify((await archive(restarted)).secrets)).toContain("instance-handoff-secret-✓");
  await post(restarted, "/api/system/instance/move-previous", { confirmReplace: true });
  expect((await waitMove(restarted)).role).toBe("retired");
  expect((await state(target)).role).toBe("active");
  expect(
    (await jsonRequest<{ data: { id: string } }>(target.baseUrl, `/api/projects/${newer.id}`)).data
      .id,
  ).toBe(newer.id);
}, 180_000);

it.each([
  { installation: "with a dashboard", apiOnly: false },
  { installation: "API-only", apiOnly: true },
])(
  "moves an existing $installation server to a fresh Desktop through an outbound pull",
  async ({ apiOnly }) => {
    const { source, target: desktop } = await pair();
    let server: RunningApi | undefined;
    let restarted: RunningApi | undefined;
    try {
      const project = await createProject(source, "Already hosted project");
      const replaced = await createProject(desktop, "Previous Desktop project");
      await jsonRequest(source.baseUrl, `/api/projects/${project.id}/env`, {
        method: "PATCH",
        body: JSON.stringify({
          environment: "production",
          upserts: [{ key: "PRESERVED_SECRET", value: "hosted-instance-secret-✓", isSecret: true }],
          deletes: [],
        }),
      });
      const original = await archive(source);
      await stopApi(source);
      // Normal hosted authentication, with no previous Desktop connection or
      // return journal. The UI's source-code flow must work independently.
      const dashboard = apiOnly ? undefined : await apiProxy(source, { mount: "/api/proxy" });
      const hostedConfig = {
        dbDir: source.dbDir,
        port: source.port,
        secret: source.secret,
        authMode: "local" as const,
        apiOnly,
        publicUrl: dashboard?.baseUrl,
      };
      server = await startApi(hostedConfig);
      apis.push(server);
      const signIn = await fetch(`${server.baseUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: dashboard?.baseUrl ?? server.baseUrl,
        },
        body: JSON.stringify({
          email: "source@example.test",
          password: "test-password-instance-only-938!",
        }),
      });
      expect(signIn.status, await signIn.clone().text()).toBe(200);
      const cookie = signIn.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      expect(cookie).not.toBe("");
      await expect(
        jsonRequest(server.baseUrl, "/api/system/instance/preflight", {
          method: "POST",
          headers: { cookie, origin: dashboard?.baseUrl ?? server.baseUrl },
          body: JSON.stringify({
            mapping: { sourceServerId: "missing", connectionServerId: "unrelated" },
          }),
        }),
      ).rejects.toThrow("source host connection changed");
      const offered = await jsonRequest<{ code: string }>(
        server.baseUrl,
        "/api/system/instance/offer",
        {
          method: "POST",
          headers: { cookie, origin: dashboard?.baseUrl ?? server.baseUrl },
          body: JSON.stringify({ direction: "source" }),
        },
      );
      await post(desktop, "/api/system/instance/move", {
        code: offered.code,
        confirmReplace: true,
      });
      expect((await waitMove(desktop)).role).toBe("active");
      expect(
        await jsonRequest(server.baseUrl, "/api/system/instance", { headers: { cookie } }),
      ).toMatchObject({
        role: "retired",
        desktop: false,
        handoff: { status: "complete" },
      });
      const moved = await archive(desktop);
      expect(moved.dump.tables.project).toEqual(original.dump.tables.project);
      expect(moved.dump.tables.user).toEqual(original.dump.tables.user);
      expect(JSON.stringify(moved.secrets)).toContain("hosted-instance-secret-✓");
      expect((await fetch(`${desktop.baseUrl}/api/projects/${replaced.id}`)).status).toBe(404);
      // The former server remains fenced across restart; it cannot resume
      // managing a stale copy or forward requests to a private Desktop address.
      await stopApi(server);
      restarted = await startApi(hostedConfig);
      apis.push(restarted);
      expect(restarted.logs()).not.toContain("[boot] backup runner:");
      const denied = await fetch(`${restarted.baseUrl}/api/projects`, { headers: { cookie } });
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({
        code: "INSTANCE_CONTROLLER_INACTIVE",
        role: "retired",
      });
      const newer = await createProject(desktop, "Created after moving to Desktop");
      expect(
        (await jsonRequest<{ data: { id: string } }>(desktop.baseUrl, `/api/projects/${newer.id}`))
          .data.id,
      ).toBe(newer.id);
    } finally {
      await stopApi(source);
      await stopApi(desktop);
      if (server) await stopApi(server);
      if (restarted) await stopApi(restarted);
    }
  },
  180_000,
);

it("restores integration credentials before auth initialization in the packaged Node API", async () => {
  const { source, target } = await pair({
    GOOGLE_CLIENT_ID: "handoff-test-client",
    GOOGLE_CLIENT_SECRET: "handoff-test-secret",
  });
  const offer = await post<{ code: string }>(target, "/api/system/instance/offer", {
    direction: "target",
  });
  await post(source, "/api/system/instance/move", { code: offer.code, confirmReplace: true });
  await waitMove(source);
  await expect.poll(() => target.child.exitCode, { timeout: 30_000 }).toBe(75);
  // Build and execute the same Node bundle recipe used by Desktop and the CLI.
  // Its lazy imports must not initialize OAuth before the encrypted env loads.
  const repo = resolve(import.meta.dirname, "../../../..");
  const bundle = await mkdtemp(join(tmpdir(), "openship-instance-bundle-"));
  roots.push(bundle);
  const entry = join(bundle, "index.mjs");
  await run(
    "bun",
    [
      "build",
      join(repo, "apps/api/src/index.ts"),
      "--target=node",
      `--outfile=${entry}`,
      "--external=cpu-features",
      "--external=ssh2",
      "--external=dockerode",
    ],
    {
      cwd: repo,
      maxBuffer: 1_000_000,
      // Bun inlines NODE_ENV while bundling. A test build would otherwise
      // hardcode @repo/db's in-memory test database into the release fixture.
      env: { ...process.env, NODE_ENV: "production", VITEST: "" },
    },
  );
  await symlink(join(repo, "node_modules"), join(bundle, "node_modules"), "dir");
  const require = createRequire(join(repo, "packages/db/package.json"));
  const resumed = await startApi({
    dbDir: target.dbDir,
    port: target.port,
    secret: target.secret,
    runtime: "node",
    entry,
    authMode: "local",
    environment: {
      OPENSHIP_MIGRATIONS_DIR: join(repo, "packages/db/drizzle"),
      OPENSHIP_PGLITE_ASSETS_DIR: dirname(require.resolve("@electric-sql/pglite")),
    },
  });
  apis.push(resumed);
  const info = await jsonRequest<{ authProviders: Array<{ id: string }> }>(
    resumed.baseUrl,
    "/api/health/env",
  );
  expect(info.authProviders).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: "google" })]),
  );
  // The source's paired session also survives the receiver restart and uses
  // the imported account under normal remote authentication.
  expect((await fetch(`${source.baseUrl}/api/projects`)).status).toBe(200);
}, 180_000);

it("resumes after a lost activation acknowledgement without reimporting or starting the old controller", async () => {
  const { source, target } = await pair();
  const proxy = await apiProxy(target, { failAction: "activate" });
  const offer = await post<{ code: string }>(proxy, "/api/system/instance/offer", {
    direction: "target",
  });
  await post(source, "/api/system/instance/move", {
    code: viaProxy(offer.code, proxy),
    confirmReplace: true,
  });
  expect((await waitError(source)).role).toBe("retired");
  expect((await state(target)).role).toBe("active");
  const newer = await createProject(target, "After activation");
  await expect(post(source, "/api/system/instance/cancel")).rejects.toThrow("already moved");
  expect(
    (
      await fetch(`${source.baseUrl}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(503);
  await stopApi(source);
  const restarted = await startApi({
    dbDir: source.dbDir,
    port: source.port,
    secret: source.secret,
  });
  apis.push(restarted);
  await post(restarted, "/api/system/instance/resume");
  await waitMove(restarted);
  expect(
    (await jsonRequest<{ data: { id: string } }>(restarted.baseUrl, `/api/projects/${newer.id}`))
      .data.id,
  ).toBe(newer.id);
}, 120_000);

it("cancels a prepared but unactivated receiver and restores its recovery archive", async () => {
  const { source, target } = await pair();
  const old = await createProject(target, "Receiver original");
  const incoming = await createProject(source, "Incoming project");
  const proxy = await apiProxy(target, { failAction: "prepare" });
  const offer = await post<{ code: string }>(proxy, "/api/system/instance/offer", {
    direction: "target",
  });
  await post(source, "/api/system/instance/move", {
    code: viaProxy(offer.code, proxy),
    confirmReplace: true,
  });
  expect((await waitError(source)).role).toBe("frozen");
  expect((await state(target)).role).toBe("prepared");
  await post(source, "/api/system/instance/cancel");
  expect((await state(source)).role).toBe("active");
  expect((await state(target)).role).toBe("active");
  expect(
    (await jsonRequest<{ data: { id: string } }>(target.baseUrl, `/api/projects/${old.id}`)).data
      .id,
  ).toBe(old.id);
  expect((await fetch(`${target.baseUrl}/api/projects/${incoming.id}`)).status).toBe(404);
  const decoded = JSON.parse(Buffer.from(offer.code, "base64url").toString());
  const replay = await fetch(`${target.baseUrl}/api/system/instance/peer/${decoded.id}/activate`, {
    method: "POST",
    headers: { authorization: `Bearer ${decoded.token}`, "content-type": "application/json" },
    body: JSON.stringify({ proof: "A".repeat(43) }),
  });
  expect(replay.status).toBe(401);
}, 120_000);

it("pairs a Desktop without copying data, rejects code replay and resumes its separate local instance", async () => {
  const { source, target } = await pair();
  const own = await createProject(source, "Local workspace");
  const remote = await createProject(target, "Remote workspace");
  const offer = await post<{ code: string }>(target, "/api/system/instance/pair");
  await post(source, "/api/system/instance/connect", { code: offer.code });
  expect((await state(source)).role).toBe("connected");
  expect((await fetch(`${source.baseUrl}/api/projects/${own.id}`)).status).toBe(404);
  expect(
    (await jsonRequest<{ data: { id: string } }>(source.baseUrl, `/api/projects/${remote.id}`)).data
      .id,
  ).toBe(remote.id);
  await expect(post(source, "/api/system/instance/connect", { code: offer.code })).rejects.toThrow(
    "connection code",
  );
  await post(source, "/api/system/instance/disconnect");
  expect((await state(source)).role).toBe("active");
  expect(
    (await jsonRequest<{ data: { id: string } }>(source.baseUrl, `/api/projects/${own.id}`)).data
      .id,
  ).toBe(own.id);
}, 120_000);

it("accepts an API-only invitation through Desktop without granting the teammate instance control", async () => {
  const { source, target } = await pair();
  await stopApi(target);
  const remote = await startApi({
    dbDir: target.dbDir,
    port: target.port,
    secret: target.secret,
    authMode: "local",
    apiOnly: true,
  });
  apis.push(remote);
  await post(source, "/api/system/instance/connect-address", {
    origin: remote.baseUrl,
    confirmed: true,
  });
  await post(source, "/api/auth/sign-in/email", {
    email: "target@example.test",
    password: "test-password-instance-only-938!",
  });
  const invitation = await post<{ id: string }>(source, "/api/auth/organization/invite-member", {
    email: "teammate@example.test",
    role: "member",
    delivery: "link",
  });
  const directory = await mkdtemp(join(tmpdir(), "openship-teammate-desktop-"));
  roots.push(directory);
  const teammate = await startApi({
    dbDir: directory,
    port: await freePort(),
    secret: "teammate-desktop-key-22222222222222222222222",
  });
  apis.push(teammate);
  await post(teammate, "/api/system/instance/connect-address", {
    origin: remote.baseUrl,
    confirmed: true,
  });
  await post(teammate, "/api/system/invite-signup", {
    invitationId: invitation.id,
    name: "Invited teammate",
    password: "test-password-teammate-only-123!",
  });
  await post(teammate, "/api/auth/sign-in/email", {
    email: "teammate@example.test",
    password: "test-password-teammate-only-123!",
  });
  const session = await jsonRequest<{ user: { id: string; role: string } }>(
    teammate.baseUrl,
    "/api/auth/get-session",
  );
  expect(session.user.role).toBe("user");
  const pairing = await post<{ code: string }>(teammate, "/api/system/instance/pair");
  const claim = JSON.parse(Buffer.from(pairing.code, "base64url").toString());
  const connection = await jsonRequest<{ cookies: Record<string, string> }>(
    remote.baseUrl,
    "/api/system/instance/pair/claim",
    { method: "POST", headers: { authorization: `Bearer ${claim.token}` } },
  );
  const cookie = Object.entries(connection.cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  // An org owner/member cannot acquire whole-instance privileges by changing
  // the selected organization or by pairing their own Desktop.
  for (const path of ["offer", "provision", "move", "resume", "cancel"]) {
    const response = await fetch(`${remote.baseUrl}/api/system/instance/${path}`, {
      method: "POST",
      headers: {
        cookie,
        origin: remote.baseUrl,
        "content-type": "application/json",
        "x-organization-id": `org_${session.user.id}`,
      },
      body: JSON.stringify({ direction: "source", confirmReplace: true }),
    });
    expect(response.status, path).toBe(403);
  }
  await expect(
    post(teammate, "/api/system/instance/return", { confirmReplace: true }),
  ).rejects.toThrow("instance administrator");
  await expect(
    jsonRequest(teammate.baseUrl, "/api/system/instance?source=connected"),
  ).rejects.toThrow("403");
  expect((await state(teammate)).role).toBe("connected");
  expect((await fetch(`${source.baseUrl}/api/projects`)).status).toBe(200);
}, 120_000);

it("authenticates by address through the remote API and keeps its cookies off the Desktop browser", async () => {
  const { source, target } = await pair();
  const project = await createProject(target, "Password protected remote project");
  await stopApi(target);
  const remote = await startApi({
    dbDir: target.dbDir,
    port: target.port,
    secret: target.secret,
    authMode: "local",
    apiOnly: true,
  });
  apis.push(remote);
  const landing = await fetch(`${remote.baseUrl}/accept-invite/invite_example`);
  expect(landing.status).toBe(200);
  expect(await landing.text()).toContain("Join your team in Desktop");
  expect(landing.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect((await fetch(`${remote.baseUrl}/api/system/instance`)).status).toBe(401);
  await post(source, "/api/system/instance/connect-address", {
    origin: remote.baseUrl,
    confirmed: true,
  });
  await expect(
    jsonRequest(source.baseUrl, "/api/system/instance?source=connected"),
  ).rejects.toThrow("401");
  expect((await fetch(`${source.baseUrl}/api/projects/${project.id}`)).status).toBe(401);
  const signIn = await fetch(`${source.baseUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "target@example.test",
      password: "test-password-instance-only-938!",
    }),
  });
  expect(signIn.status, await signIn.clone().text()).toBe(200);
  expect(signIn.headers.get("set-cookie")).toBeNull();
  expect(
    (await jsonRequest<{ data: { id: string } }>(source.baseUrl, `/api/projects/${project.id}`))
      .data.id,
  ).toBe(project.id);
  const session = await jsonRequest<{ user: { email: string } }>(
    source.baseUrl,
    "/api/auth/get-session",
  );
  expect(session.user.email).toBe("target@example.test");
  expect(await jsonRequest(source.baseUrl, "/api/system/instance?source=connected")).toEqual({
    localHosts: [],
  });
  const enrollment = await post<{ totpURI: string; backupCodes: string[] }>(
    source,
    "/api/auth/two-factor/enable",
    { password: "test-password-instance-only-938!" },
  );
  const secret = new URL(enrollment.totpURI).searchParams.get("secret")!;
  const bits = [...secret.replace(/=+$/, "").toUpperCase()]
    .map((char) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const code = String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
  await post(source, "/api/auth/two-factor/verify-totp", { code });
  await post(source, "/api/auth/sign-out");
  expect((await fetch(`${source.baseUrl}/api/projects/${project.id}`)).status).toBe(401);
  expect(
    await post(source, "/api/auth/sign-in/email", {
      email: "target@example.test",
      password: "test-password-instance-only-938!",
    }),
  ).toMatchObject({ twoFactorRedirect: true });
  expect((await fetch(`${source.baseUrl}/api/projects/${project.id}`)).status).toBe(401);
  await expect(
    post(source, "/api/auth/two-factor/verify-totp", { code: "invalid" }),
  ).rejects.toThrow();
  expect((await fetch(`${source.baseUrl}/api/projects/${project.id}`)).status).toBe(401);
  const verifyBackup = () =>
    fetch(`${source.baseUrl}/api/auth/two-factor/verify-backup-code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: enrollment.backupCodes[0] }),
    });
  let verified = await verifyBackup();
  // Enrollment and the deliberately wrong challenge use the same real
  // three-attempt / ten-second auth bucket. Respect its retry window instead
  // of depending on a slow test machine or disabling production rate limits.
  if (verified.status === 429) {
    const seconds = Number(verified.headers.get("retry-after"));
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThanOrEqual(10);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 100));
    verified = await verifyBackup();
  }
  expect(verified.status, await verified.text()).toBe(200);
  expect(
    (await jsonRequest<{ data: { id: string } }>(source.baseUrl, `/api/projects/${project.id}`))
      .data.id,
  ).toBe(project.id);
  await post(source, "/api/system/instance/disconnect");
  expect((await state(source)).role).toBe("active");
  await expect(
    jsonRequest(source.baseUrl, "/api/system/instance?source=connected"),
  ).rejects.toThrow("409");
}, 120_000);
