// Run with Node.js 22+ after installing an SDK-enabled openship tarball.
// This demo owns a temporary installation and removes it on completion.
// @ts-check
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShip } from "openship";

const stateDirectory = await mkdtemp(join(tmpdir(), "openship-sdk-example-"));
// Keep this key with your persistent installation in a real application.
const encryptionKey = randomBytes(32).toString("hex");
/** @type {Map<string, import("openship/native").VerifiedIdentity>} */
const sessions = new Map();
/** @type {import("openship").NativeShipOptions<string>} */
const options = {
  instanceId: "sdk-example",
  stateDirectory,
  storage: { driver: "pglite", dataDir: join(stateDirectory, "database") },
  encryptionKey,
  runtime: "bare",
  routing: "none",
  policy: { allowHostExecution: true },
  administration: true,
  diagnostics: "stderr",
  // Only trusted host code populates this demo's session map. In a real
  // application, verify the caller's session with your authentication service.
  identity: { resolve: async (assertion) => sessions.get(assertion) ?? null },
};
/** @type {import("openship").OwnedShip<string> | undefined} */
let ship;

/** @param {import("openship").DeploymentHandle} deployment */
async function waitUntilReady(deployment) {
  const outcome = await deployment.wait({ timeoutMs: 60_000, pollIntervalMs: 100 });
  assert.equal(outcome.success, true, JSON.stringify(outcome));
  assert.equal(outcome.status, "ready");
  return deployment.get();
}

try {
  // 1. The host provisions users; each SDK scope selects an authorized tenant.
  ship = await createShip(options);
  assert.ok(ship.operator);
  const alice = await ship.operator.ensureIdentity({
    issuer: "sdk-example", subject: "alice", email: "alice@example.test",
  });
  const bob = await ship.operator.ensureIdentity({
    issuer: "sdk-example", subject: "bob", email: "bob@example.test",
  });
  const aliceSession = randomUUID();
  const bobSession = randomUUID();
  sessions.set(aliceSession, { user: alice.user, sessionId: aliceSession });
  sessions.set(bobSession, { user: bob.user, sessionId: bobSession });
  await ship.start();
  const customer = await ship.scope({
    identity: aliceSession, organizationId: alice.personalOrganizationId,
  });
  const otherCustomer = await ship.scope({
    identity: bobSession, organizationId: bob.personalOrganizationId,
  });
  console.log("Created two independent user scopes.");

  // 2. Deploy generated files through the normal source/build pipeline.
  // With routing: none, this produces a static release without a public URL.
  const first = await customer.deploy({
    name: "generated-site",
    source: { type: "files", files: { "index.html": "<h1>Hello from version 1</h1>" } },
    onStep: (message) => console.log(message),
  });
  const firstDeployment = await waitUntilReady(customer.deployment(first.deployment_id));
  assert.equal(firstDeployment.projectId, first.project_id);
  const project = await customer.projects.get(first.project_id);
  assert.equal(project.organizationId, alice.personalOrganizationId);
  assert.equal(project.activeDeploymentId, first.deployment_id);
  console.log(`Deployed project ${project.id}.`);

  // 3. Update configuration and deploy changed code into the SAME project.
  const secret = randomBytes(24).toString("hex");
  await customer.projects.mergeEnvVars(project.id, {
    environment: "production",
    upserts: [
      { key: "APP_MESSAGE", value: "Hello from version 2", isSecret: false },
      { key: "PRIVATE_TOKEN", value: secret, isSecret: true },
    ],
    deletes: [],
  });
  const second = await customer.deploy({
    projectId: project.id,
    source: { type: "files", files: { "index.html": "<h1>Hello from version 2</h1>" } },
  });
  assert.equal(second.project_id, project.id);
  assert.notEqual(second.deployment_id, first.deployment_id);
  await waitUntilReady(customer.deployment(second.deployment_id));
  assert.equal((await customer.projects.get(project.id)).activeDeploymentId, second.deployment_id);
  const history = await customer.deployments.list({ projectId: project.id });
  assert.equal(history.total, 2);
  assert.deepEqual(new Set(history.data.map((item) => item.id)), new Set([first.deployment_id, second.deployment_id]));
  console.log("Updated configuration and deployed version 2; both releases are in history.");

  // 4. Knowing a resource ID does not give another user access to it.
  assert.equal((await otherCustomer.projects.list()).total, 0);
  await assert.rejects(otherCustomer.projects.get(project.id), { code: "NOT_FOUND" });
  await assert.rejects(otherCustomer.deployments.get(second.deployment_id), { code: "NOT_FOUND" });
  await assert.rejects(otherCustomer.projects.remove(project.id), { code: "NOT_FOUND" });
  sessions.delete(bobSession);
  await assert.rejects(otherCustomer.projects.list(), { code: "UNAUTHORIZED" });
  console.log("Checked tenant isolation and session revocation.");

  // 5. Close, then reopen with the same installation ID, storage, and key.
  await ship.close({ mode: "drain" });
  ship = undefined;
  await assert.rejects(customer.projects.list(), { code: "PLATFORM_CLOSED" });
  ship = await createShip({ ...options, storage: { ...options.storage, migrations: "verify" } });
  assert.ok(ship.operator);
  const restored = await ship.operator.resolveIdentity({ issuer: "sdk-example", subject: "alice" });
  assert.equal(restored?.user.id, alice.user.id);
  await ship.start();
  const reopened = await ship.scope({
    identity: aliceSession, organizationId: alice.personalOrganizationId,
  });
  assert.equal((await reopened.projects.get(project.id)).activeDeploymentId, second.deployment_id);
  assert.equal((await reopened.deployments.get(second.deployment_id)).status, "ready");
  const variables = await reopened.projects.listEnvVars(project.id);
  assert.equal(variables.find((item) => item.key === "APP_MESSAGE")?.value, "Hello from version 2");
  assert.equal(variables.find((item) => item.key === "PRIVATE_TOKEN")?.isSecret, true);
  assert.equal(JSON.stringify(variables).includes(secret), false);
  console.log("Reopened saved projects, deployments, and configuration; secret values stay masked.");

  // 6. Use normal project teardown and verify the records are gone.
  const removed = await reopened.projects.remove(project.id);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  assert.equal((await reopened.projects.list()).total, 0);
  await assert.rejects(reopened.projects.get(project.id), { code: "NOT_FOUND" });
  await assert.rejects(reopened.deployments.get(second.deployment_id), { code: "NOT_FOUND" });
  console.log("Deleted the project and its deployments through the SDK.");
} finally {
  // Drain before removing files. This directory was created by this example;
  // do not delete the state directory of a persistent application on shutdown.
  await ship?.close({ mode: "drain" });
  await rm(stateDirectory, { recursive: true, force: true });
}

console.log("Native SDK lifecycle completed; temporary installation removed.");
