/** Installs the actual tarball outside the workspace, under the caller's Node runtime. */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "openship-package-"));
const node = process.env.OPENSHIP_TEST_NODE ?? process.argv[2] ?? "node";
const run = (bin: string, args: string[], cwd = scratch, env = process.env) => execFileSync(bin, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 180_000 });

try {
  run("bun", ["run", "check"], packageDir);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], packageDir)) as Array<{ filename: string; size: number; unpackedSize: number }>;
  const archive = packed[0]!;
  writeFileSync(join(scratch, "package.json"), JSON.stringify({
    name: "openship-external-check", private: true, type: "module",
    dependencies: { openship: `file:${join(scratch, archive.filename)}` },
    devDependencies: { typescript: "^5.9.3", "@types/node": "^22.13.0" },
  }, null, 2));
  run("npm", ["install", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--no-package-lock"]);
  const installed = join(scratch, "node_modules/openship");
  writeFileSync(join(scratch, "probe.mjs"), `
import assert from 'node:assert/strict';
const environment = { ...process.env };
const root = await import('openship');
const native = await import('openship/native');
const client = await import('openship/client');
assert.equal(typeof root.createShip, 'function');
assert.equal(typeof root.OpenshipClient, 'function');
assert.equal(typeof native.createShip, 'function');
assert.equal(typeof client.OpenshipClient, 'function');
assert.equal(typeof root.OpenshipOperatorClient, 'function');
assert.equal(typeof client.OpenshipOperatorClient, 'function');
assert.deepEqual({ ...process.env }, environment);
assert.equal(process.getActiveResourcesInfo().includes('Timeout'), false);
let requests = 0;
for (const Client of [root.OpenshipClient, client.OpenshipClient]) {
  const ship = new Client({ baseUrl: 'https://ship.example.test', token: 'secret', fetch: async (url, init) => {
    requests++;
    assert.equal(url, 'https://ship.example.test/api/deployments');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer secret');
    assert.deepEqual(JSON.parse(init.body), { projectId: 'project-a', forceAll: true });
    return Response.json({ data: { deployment_id: 'dep-a', project_id: 'project-a' } }, { status: 202 });
  } });
  assert.deepEqual(await ship.deployments.create({ projectId: 'project-a', forceAll: true, reuseSnapshot: {} }), { deployment_id: 'dep-a', project_id: 'project-a' });
  assert.equal(ship.deployment('dep-a').id, 'dep-a');
}
assert.equal(requests, 2);
console.log('ESM_OK');
`);
  if (!run(node, ["probe.mjs"]).includes("ESM_OK")) throw new Error("ESM package probe failed");
  writeFileSync(join(scratch, "probe.cjs"), `
const assert = require('node:assert/strict');
const environment = { ...process.env };
for (const name of ['openship', 'openship/native']) assert.equal(typeof require(name).createShip, 'function');
assert.equal(typeof require('openship').OpenshipClient, 'function');
assert.equal(typeof require('openship/client').OpenshipClient, 'function');
assert.equal(typeof require('openship').OpenshipOperatorClient, 'function');
assert.equal(typeof require('openship/client').OpenshipOperatorClient, 'function');
assert.deepEqual({ ...process.env }, environment);
assert.equal(process.getActiveResourcesInfo().includes('Timeout'), false);
console.log('CJS_OK');
`);
  if (!run(node, ["probe.cjs"]).includes("CJS_OK")) throw new Error("CommonJS package probe failed");
  writeFileSync(join(scratch, "native-probe.mjs"), `
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
const { createShip } = process.argv[2] === 'cjs' ? createRequire(import.meta.url)('openship/native') : await import('openship');
const environment = { ...process.env };
const directory = await mkdtemp(join(tmpdir(), 'openship-installed-native-'));
let identity = null;
let ship;
const options = {
  instanceId: 'installed', stateDirectory: directory,
  storage: { driver: 'pglite', dataDir: join(directory, 'database') },
  encryptionKey: 'installed-sdk-smoke-test-persistent-key-32-bytes',
  runtime: 'bare', routing: 'none', administration: true,
  policy: { allowHostExecution: true },
  identity: { resolve: async assertion => assertion === 'verified-host-session' ? identity : null },
};
try {
  ship = await createShip(options);
  const mapping = await ship.operator.ensureIdentity({ issuer: 'integration', subject: 'alice', email: 'alice@example.test' });
  identity = { user: mapping.user, sessionId: 'host-session' };
  await ship.start();
  const scoped = await ship.scope({ identity: 'verified-host-session', organizationId: mapping.personalOrganizationId });
  const plans = await scoped.billing.listPlans({ locale: 'ar' });
  assert.equal(plans.locale, 'ar');
  assert.ok(plans.plans.length > 0);
  const notice = await ship.operator.notices.create({ title: 'Installed SDK', message: 'Persistent operator notice' });
  assert.ok((await scoped.notices.list()).advisories.some(item => item.id === notice.id));
  assert.equal(scoped.notices.create, undefined);
  const submitted = await scoped.deploy({ name: 'installed-app', source: { type: 'files', files: { 'index.html': '<h1>Installed SDK</h1>' } } });
  const outcome = await scoped.deployment(submitted.deployment_id).wait({ timeoutMs: 30000, pollIntervalMs: 100 });
  assert.equal(outcome.success, true);
  assert.equal(outcome.status, 'ready');
  const row = await scoped.deployments.get(submitted.deployment_id);
  const artifact = join(directory, 'installed/workloads/static/releases', submitted.deployment_id);
  assert.equal(row.containerId, artifact);
  assert.equal(await readFile(join(artifact, 'index.html'), 'utf8'), '<h1>Installed SDK</h1>');
  await scoped.projects.mergeEnvVars(submitted.project_id, { environment: 'production', upserts: [
    { key: 'PRIVATE_TOKEN', value: 'installed-native-secret', isSecret: true },
  ], deletes: [] });
  assert.equal(JSON.stringify(await scoped.projects.listEnvVars(submitted.project_id)).includes('installed-native-secret'), false);
  const tokenState = await scoped.projects.updateCloneToken(submitted.project_id, { token: 'installed-clone-secret' });
  assert.equal(tokenState.hasToken, true);
  await scoped.projects.setSleepMode(submitted.project_id, { sleep_mode: 'always_on' });
  const updated = await scoped.deploy({ projectId: submitted.project_id, source: { type: 'files', files: { 'index.html': '<h1>Updated SDK deployment</h1>' } } });
  assert.equal(updated.project_id, submitted.project_id);
  assert.notEqual(updated.deployment_id, submitted.deployment_id);
  assert.equal((await scoped.deployment(updated.deployment_id).wait({ timeoutMs: 30000, pollIntervalMs: 100 })).success, true);
  const updatedArtifact = join(directory, 'installed/workloads/static/releases', updated.deployment_id);
  assert.equal((await scoped.deployments.get(updated.deployment_id)).containerId, updatedArtifact);
  assert.equal(await readFile(join(updatedArtifact, 'index.html'), 'utf8'), '<h1>Updated SDK deployment</h1>');
  assert.equal(await readFile(join(artifact, 'index.html'), 'utf8'), '<h1>Installed SDK</h1>');
  await ship.close();
  ship = await createShip({ ...options, storage: { ...options.storage, migrations: 'verify' } });
  assert.equal((await ship.operator.resolveIdentity({ issuer: 'integration', subject: 'alice' })).user.id, mapping.user.id);
  await ship.start();
  const reopened = await ship.scope({ identity: 'verified-host-session', organizationId: mapping.personalOrganizationId });
  assert.ok((await reopened.notices.list()).advisories.some(item => item.id === notice.id));
  await ship.operator.notices.remove(notice.id);
  assert.equal((await reopened.notices.list()).advisories.some(item => item.id === notice.id), false);
  assert.equal((await reopened.projects.list()).data[0].id, submitted.project_id);
  assert.deepEqual(await reopened.projects.getCloneToken(submitted.project_id), tokenState);
  assert.equal((await reopened.projects.getResources(submitted.project_id)).sleepMode, 'always_on');
  assert.equal((await reopened.projects.listEnvVars(submitted.project_id))[0].key, 'PRIVATE_TOKEN');
  assert.equal((await reopened.projects.get(submitted.project_id)).activeDeploymentId, updated.deployment_id);
  assert.equal(await readFile(join(updatedArtifact, 'index.html'), 'utf8'), '<h1>Updated SDK deployment</h1>');
  const removed = await reopened.projects.remove(submitted.project_id);
  assert.equal(removed.ok, true, JSON.stringify(removed));
  await assert.rejects(stat(artifact), { code: 'ENOENT' });
  await assert.rejects(stat(updatedArtifact), { code: 'ENOENT' });
  assert.deepEqual({ ...process.env }, environment);
  console.log('NATIVE_OK');
} finally {
  await ship?.close();
  await rm(directory, { recursive: true, force: true });
}
`);
  for (const mode of ["esm", "cjs"]) {
    if (!run(node, ["native-probe.mjs", mode]).includes("NATIVE_OK")) throw new Error(`Installed native ${mode} deployment failed`);
  }
  // Run the exact shipped example as a consumer-owned file outside the repo.
  // It uses public SDK imports, real storage and the real deployment pipeline.
  cpSync(join(installed, "examples/native-lifecycle.mjs"), join(scratch, "native-example.mjs"));
  const lifecycle = run(node, ["native-example.mjs"]);
  if (!lifecycle.includes("Native SDK lifecycle completed; temporary installation removed."))
    throw new Error("Installed native lifecycle example did not complete");
  const example = `import { OpenshipClient, OpenshipOperatorClient, type DeploymentHandle, type ProjectOperations, type EnvironmentVariable, type BillingOperations, type NoticeOperations, type OperatorNoticeOperations } from 'openship';
import { createShip, type IdentityAdapter } from 'openship/native';
const client = new OpenshipClient({ baseUrl: 'https://ship.example.test' });
const handle: DeploymentHandle = client.deployment('deployment');
const identity: IdentityAdapter<string> = { resolve: async () => null };
const operatorNotices: OperatorNoticeOperations = new OpenshipOperatorClient({ baseUrl: 'https://ship.example.test', internalToken: 'operator' }).notices;
async function nativeExample() {
  const ship = await createShip({
    instanceId: 'types', stateDirectory: '/tmp/openship-types', storage: { driver: 'pglite', dataDir: 'memory://' },
    runtime: 'bare', routing: 'none', encryptionKey: 'example-key-with-at-least-32-bytes', identity,
  });
  const scoped = await ship.scope({ identity: 'host-assertion', organizationId: 'org' });
  const nativeProjects: ProjectOperations = scoped.projects;
  const remoteProjects: ProjectOperations = client.projects;
  const nativeBilling: BillingOperations = scoped.billing;
  const remoteBilling: BillingOperations = client.billing;
  const notices: NoticeOperations = scoped.notices;
  const project = await scoped.projects.create({ name: 'example' });
  const variables: EnvironmentVariable[] = await nativeProjects.listEnvVars(project.id);
  await remoteProjects.setBranch(project.id, { branch: 'main' });
  const source = await scoped.sources.stage({ source: { type: 'files', files: { 'index.html': '<h1>Example</h1>' } }, projectId: project.id });
  void source; void variables; void nativeBilling; void remoteBilling; void notices; void operatorNotices;
  await ship.close();
}
void handle; void nativeExample;
`;
  writeFileSync(join(scratch, "example.mts"), example);
  writeFileSync(join(scratch, "example.cts"), example);
  run(node, ["node_modules/typescript/bin/tsc", "--noEmit", "--strict", "--allowJs", "--checkJs", "--target", "ES2022", "--module", "NodeNext", "--moduleResolution", "NodeNext", "example.mts", "example.cts", "native-example.mjs"]);
  const version = run(node, [join(installed, "dist/node-entry.js"), "--version"]).trim();
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (version !== manifest.version) throw new Error(`CLI version mismatch: ${version}`);
  const linkedCommand = join(scratch, "node_modules/.bin", process.platform === "win32" ? "openship.cmd" : "openship");
  if (!existsSync(linkedCommand)) throw new Error("npm did not install the openship command");
  // Exercise npm's command resolution, using the same Node runtime as the imports.
  const nodeExecutable = run(node, ["-p", "process.execPath"]).trim();
  const npmEnvironment = { ...process.env, PATH: [dirname(nodeExecutable), process.env.PATH].filter(Boolean).join(delimiter) };
  const npmVersion = run("npm", ["exec", "--offline", "--", "openship", "--version"], scratch, npmEnvironment).trim();
  if (npmVersion !== manifest.version) throw new Error(`npm CLI version mismatch: ${npmVersion}`);
  if (!run(node, [join(installed, "dist/node-entry.js"), "up", "--help"]).includes("--compose")) throw new Error("Installed CLI failed to load");
  const nativeConfig = join(scratch, "native-cli.mjs");
  const nativeState = join(scratch, "cli-state");
  const noHttp = join(scratch, "no-cli-http.mjs");
  writeFileSync(noHttp, "globalThis.fetch = async () => { throw new Error('unexpected CLI HTTP request'); };\n");
  writeFileSync(nativeConfig, `
let identity = null;
export default {
  options: {
    instanceId: 'installed-cli', stateDirectory: ${JSON.stringify(nativeState)},
    storage: { driver: 'pglite', dataDir: ${JSON.stringify(join(nativeState, "database"))} },
    encryptionKey: 'installed-cli-smoke-persistent-key-32-bytes',
    runtime: 'bare', routing: 'none', administration: true,
    identity: { resolve: async assertion => assertion === 'cli' ? identity : null },
  },
  async scope(ship) {
    const mapped = await ship.operator.ensureIdentity({ issuer: 'installed-cli', subject: 'alice', email: 'alice@example.test' });
    identity = { user: mapped.user, sessionId: 'cli-session' };
    return { identity: 'cli', organizationId: mapped.personalOrganizationId };
  },
};
`);
  const cli = (args: string[]) => run(node, ["--import", noHttp, join(installed, "dist/node-entry.js"), "--native-config", nativeConfig, "--json", ...args]);
  const created = JSON.parse(cli(["project", "create", "--name", "Installed CLI Project"]));
  if (!created.id || created.name !== "Installed CLI Project") throw new Error("Installed native CLI project creation failed");
  let failed = false;
  try { cli(["project", "get", "missing-project"]); }
  catch (error) {
    const result = error as Error & { status?: number; stderr?: string };
    if (result.status !== 1 || !result.stderr?.toLowerCase().includes("not found")) throw error;
    failed = true;
  }
  if (!failed) throw new Error("Installed native CLI did not report an operation failure");
  const reopened = JSON.parse(cli(["project", "list"])) as Array<{ id: string }>;
  if (!reopened.some(project => project.id === created.id)) throw new Error("Installed native CLI failed to reopen after an operation failure");
  const status = JSON.parse(cli(["status"]));
  if (status.mode !== "native" || status.instanceId !== "installed-cli" || status.organizationId !== created.organizationId)
    throw new Error("Installed native CLI scope mismatch");
  console.log(lifecycle.trim());
  console.log(`[openship] installed package passed on Node ${run(node, ["--version"]).trim()}: ESM, CommonJS, NodeNext types, passive imports, owned native deployment/persistence, runnable lifecycle example (redeployment, tenant isolation, revocation, persistence, teardown), remote submission, npm command, native CLI persistence/cleanup, CLI (${version}); ${(archive.size / 1024 / 1024).toFixed(1)} MB packed / ${(archive.unpackedSize / 1024 / 1024).toFixed(1)} MB unpacked`);
} catch (error) {
  const failure = error as Error & { stdout?: string; stderr?: string };
  console.error(failure.stdout ?? "", failure.stderr ?? "");
  throw error;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
