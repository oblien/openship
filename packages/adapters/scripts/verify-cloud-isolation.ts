/** Staging acceptance for namespace isolation and provider quota enforcement.
 * Uses two NEW capped namespaces, no checkout/payment, and deletes them in finally.
 * bun packages/adapters/scripts/verify-cloud-isolation.ts --staging-env /private/staging.env
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Oblien } from "../src/oblien";
import { cloudWorkspaceStatus, waitForCloudDockerWorkspace } from "../src/runtime/cloud/workspace-ready";
import { CloudWorkspaceExecutor } from "../src/runtime/cloud/workspace-executor";
import { deleteCloudWorkspace } from "../src/runtime/cloud/workspace-delete";

if (process.argv[2] !== "--staging-env" || !process.argv[3]) throw new Error("Provide a confirmed staging credential file with --staging-env");
const config = parseEnv(await readFile(process.argv[3], "utf8"));
const baseUrl = config.OBLIEN_API_URL || "https://api.oblien.com";
if (!config.OBLIEN_CLIENT_ID || !config.OBLIEN_CLIENT_SECRET || new URL(baseUrl).protocol !== "https:") throw new Error("Staging credentials and HTTPS are required");
const admin = new Oblien({ clientId: config.OBLIEN_CLIENT_ID, clientSecret: config.OBLIEN_CLIENT_SECRET, baseUrl });
const tag = `os-cycle-${randomUUID().replaceAll("-", "").slice(0, 14)}`;
const directory = await mkdtemp(join(tmpdir(), "openship-cloud-isolation-"));
const startedAt = new Date();
const namespaceIds = new Map<string, string>();
const pages = new Map<string, string>();
const report: Array<{ check: string; passed: boolean }> = [];
const abort = new AbortController();
const stop = () => abort.abort(new Error("Staging test interrupted"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const log = (check: string, details: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), check, ...details }));
const save = () => writeFile(join(directory, "resources.json"), JSON.stringify({ namespaces: Object.fromEntries(namespaceIds), pages: Object.fromEntries(pages) }), { mode: 0o600 });
function check(name: string, condition: unknown, fatal = true) {
  report.push({ check: name, passed: Boolean(condition) });
  log(name, { passed: Boolean(condition) });
  if (!condition) {
    process.exitCode = 1;
    if (fatal) throw new Error(name);
  }
}
async function denied(name: string, work: () => Promise<unknown>, statuses: number[]) {
  try { await work(); }
  catch (error) {
    const status = Number((error as { status?: number }).status);
    check(name, statuses.includes(status));
    return;
  }
  check(name, false);
}
async function until(name: string, predicate: () => Promise<boolean>, timeout = 120_000) {
  const start = Date.now();
  let reported = start;
  while (!await predicate()) {
    abort.signal.throwIfAborted();
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${name}`);
    if (Date.now() - reported > 15_000) { log(`waiting: ${name}`); reported = Date.now(); }
    await delay(1000, undefined, { signal: abort.signal });
  }
}
async function suspendedWorkspaceStops(client: Oblien, workspaceId: string, namespace: string, name: string) {
  let observedState: string | undefined;
  try {
    await until(name, async () => {
      const workspace = await client.workspaces.get(workspaceId);
      const state = cloudWorkspaceStatus(workspace);
      if (state !== observedState) {
        const info = workspace.info as { status?: string; is_running?: boolean } | undefined;
        log("suspension workspace state", { namespace, workspaceId, state, info: { status: info?.status, is_running: info?.is_running }, ready: workspace.ready });
        observedState = state;
      }
      return state === "stopped";
    });
    check(name, true);
  } catch (error) {
    abort.signal.throwIfAborted();
    check(name, false, false);
    const namespaceState = (await admin.namespaces.get(namespace)).data;
    log("manual suspension diagnostic", { namespace, workspaceId,
      namespaceState: { status: namespaceState.status },
      balance: await admin.billing.balance(namespace),
      message: error instanceof Error ? error.message : "Unknown failure" });
    // Preserve the failed automatic-stop result, then exercise the independent
    // customer cleanup and explicit-reactivation contract on the same fixture.
    await client.workspace(workspaceId).stop();
    await until("explicit Stop completes during suspension", async () => cloudWorkspaceStatus(await client.workspaces.get(workspaceId)) === "stopped");
  }
}
const a = `${tag}-a`, b = `${tag}-b`;
const resources = { max_workspaces: 1, max_vcpus: 2, max_ram_mb: 4096, max_disk_gb: 32 };
const policy = (quotaLimit: number) => ({ quotaLimit, overdraft: 0, suspendThreshold: 0, onOverdraftAction: "stop_workspaces" as const });
const create = (namespace: string, suffix: string) => ({ namespace, name: `${namespace}-${suffix}`, slug: `${namespace}-${suffix}`,
  image: "oblien/docker:29", mode: "temporary" as const, wait_ready: false, idempotency_key: `${namespace}-${suffix}`,
  config: { cpus: 2, memory_mb: 4096, disk_size_mb: 32768, ttl: "15m", ttl_action: "remove" as const,
    remove_on_exit: false, wait_for_init: true, network_config: { allow_internet: true, public_ingress: false } } });

try {
  log("starting isolated quota test", { directory });
  const defaults = await admin.billing.defaults();
  check("new namespaces have finite automatic onboarding policy", defaults.autoApply && defaults.quotaLimit === 0 && defaults.overdraft === 0 && defaults.suspendThreshold === 0 && defaults.onOverdraftAction === "stop_workspaces");
  for (const namespace of [a, b]) {
    const input = { name: namespace, slug: namespace, resource_limits: resources };
    const { data } = namespace === a ? await admin.namespaces.ensure(input) : await admin.namespaces.create(input);
    namespaceIds.set(namespace, data.id);
    await save();
    const entitlement = await admin.billing.entitlement(namespace);
    const balance = await admin.billing.balance(namespace);
    const inheritedPolicy = await admin.billing.policy(namespace);
    log("new namespace billing", { customer: namespace === a ? "A" : "B", method: namespace === a ? "ensure" : "create", entitlement, balance,
      policy: inheritedPolicy, subscription: await admin.billing.subscription(namespace) });
    check(`${namespace === a ? "A" : "B"}: zero credit inherited without a grant`, entitlement.namespace === namespace && entitlement.quota.limit === 0 && balance.blocking &&
      inheritedPolicy.quotaLimit === 0 && inheritedPolicy.overdraft === 0 && inheritedPolicy.suspendThreshold === 0 && inheritedPolicy.onOverdraftAction === "stop_workspaces", false);
    const subscription = (await admin.billing.subscription(namespace)).subscription;
    check(`${namespace === a ? "A" : "B"}: unpaid namespace cannot inherit the owner's plan`, subscription === null && (entitlement.tierId === null || entitlement.tierId === "free") && entitlement.periodStart === null && entitlement.periodEnd === null, false);
    // Continue the independent enforcement checks with an explicit fixture
    // policy. The failed onboarding checks stay failed in the final report.
    if (entitlement.quota.limit !== 0) {
      log("setting explicit zero policy for the isolated test fixture", { customer: namespace === a ? "A" : "B" });
      await admin.billing.setPolicy(namespace, policy(0));
    }
  }
  const tokenA = (await admin.tokens.create({ scope: "namespace", namespace: a, ttl: 1800 })).token;
  const clientA = new Oblien({ token: tokenA, baseUrl });
  const clientB = new Oblien({ token: (await admin.tokens.create({ scope: "namespace", namespace: b, ttl: 1800 })).token, baseUrl });
  for (const client of [clientA, clientB]) {
    const request = client._http.request.bind(client._http);
    client._http.request = async <T>(input: Parameters<typeof client._http.request>[0]): Promise<T> => {
      const result = await request<T>(input);
      if (input.method === "POST" && input.path === "/workspace") {
        const data = result as Record<string, unknown>;
        log("workspace creation response shape", { keys: Object.keys(data), success: data.success, code: data.code,
          error: typeof data.error === "string" ? data.error : undefined,
          hasWorkspace: Boolean(data.workspace), dataKeys: data.data && typeof data.data === "object" ? Object.keys(data.data) : undefined });
      }
      return result;
    };
  }
  check("exhausted customers retain scoped inspection access", (await clientA.workspaces.list()).workspaces.length === 0);
  await denied("unpaid namespace cannot create compute", () => clientA.workspaces.create(create(a, "unpaid")), [402, 403]);

  for (const namespace of [a, b]) await admin.billing.setPolicy(namespace, policy(100));
  check("isolated test allowance activates only its namespace", (await admin.billing.entitlement(a)).status === "active" && !(await admin.billing.balance(b)).blocking);
  const repeated = await admin.namespaces.ensure({ name: a, slug: a, resource_limits: resources });
  check("ensure preserves an existing namespace's allowance", repeated.data.id === namespaceIds.get(a) && (await admin.billing.policy(a)).quotaLimit === 100);
  const raced = await Promise.allSettled([clientA.workspaces.create(create(a, "race-1")), clientA.workspaces.create(create(a, "race-2"))]);
  const winners = raced.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof clientA.workspaces.create>>> => item.status === "fulfilled");
  const losers = raced.filter(item => item.status === "rejected");
  log("concurrent create outcomes", { results: raced.map(item => item.status === "fulfilled"
    ? { state: item.status, workspaceId: item.value?.id, namespace: item.value?.namespace }
    : { state: item.status, status: item.reason?.status, code: item.reason?.code, message: item.reason?.message }) });
  check("namespace workspace cap survives concurrent creates", winners.length === 1 && losers.length === 1 && [400, 409, 422].includes(Number((losers[0] as PromiseRejectedResult).reason?.status)));
  const workspaceA = winners[0]!.value;
  // Inspect the actual wire status, independently of Openship's compatibility
  // normalization for the provider's former HTTP-200 limit failures.
  const limited = await fetch(new URL("/workspace", baseUrl), {
    method: "POST", headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
    body: JSON.stringify(create(a, "raw-limit")), redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  log("workspace cap wire response", { status: limited.status });
  check("workspace cap returns HTTP 409", limited.status === 409);
  await limited.arrayBuffer();
  const workspaceB = await clientB.workspaces.create(create(b, "main"));
  await waitForCloudDockerWorkspace(clientA, workspaceA.id, a, { signal: abort.signal });
  await waitForCloudDockerWorkspace(clientB, workspaceB.id, b, { signal: abort.signal });
  check("two customers own different workspaces", workspaceA.id !== workspaceB.id && workspaceA.namespace === a && workspaceB.namespace === b);
  for (const [client, workspace, namespace] of [[clientA, workspaceA, a], [clientB, workspaceB, b]] as const) {
    const executor = new CloudWorkspaceExecutor(() => client.workspace(workspace.id).runtime());
    const path = `/opt/openship/cloud-docker/routes/${namespace}`;
    try {
      await executor.mkdir(path); await executor.writeFile(`${path}/index.html`, `Isolated customer ${namespace}`);
      if (namespace === a) {
        log("running bounded CPU usage fixture");
        await executor.exec("python3 -c 'from time import monotonic; until=monotonic()+12\nwhile monotonic()<until: pass'");
      }
    }
    finally { await executor.dispose(); }
    pages.set(namespace, namespace);
    await save();
    await admin.pages.create({ slug: namespace, namespace, workspace_id: workspace.id, path, domain: "preview.oblien.com" });
  }
  const visibleA = (await clientA.workspaces.list()).workspaces;
  const visibleB = (await clientB.workspaces.list()).workspaces;
  check("workspace lists are isolated", visibleA.length === 1 && visibleA[0]!.namespace === a && visibleB.length === 1 && visibleB[0]!.namespace === b);
  await denied("customer cannot read another customer's VM", () => clientA.workspaces.get(workspaceB.id), [403, 404]);
  await denied("customer cannot stop another customer's VM", () => clientA.workspace(workspaceB.id).stop(), [403, 404]);
  await denied("customer cannot delete another customer's VM", () => clientA.workspaces.delete(workspaceB.id), [403, 404]);
  await denied("customer cannot escape its namespace on creation", () => clientA.workspaces.create(create(b, "escape")), [400, 403, 409, 422]);
  check("foreign namespace still owns exactly its original workspace", (await clientB.workspaces.list()).workspaces.length === 1);
  await denied("customer cannot access account billing", () => clientA.billing.entitlement(b), [403]);
  await denied("customer cannot grant itself credit", () => clientA.billing.setPolicy(a, policy(500)), [403]);
  await denied("customer cannot mint a more privileged token", () => clientA.tokens.create({ scope: "namespace", namespace: b }), [403]);
  try {
    const visible = (await clientA.pages.list()).pages;
    log("scoped Page listing", { count: visible.length, foreignCount: visible.filter(page => page.namespace !== a).length });
    check("Page listing cannot expose another namespace", visible.every(page => page.namespace === a), false);
  } catch (error) { check("Page listing requires privileged proxy", (error as { status?: number }).status === 403); }
  await denied("customer cannot read another customer's Page", () => clientA.pages.get(b), [403, 404]);
  await denied("namespace CPU ceiling blocks resize", () => clientA.workspace(workspaceA.id).resources.update({ cpus: 3, apply: false }), [400, 409, 422]);
  await denied("namespace RAM ceiling blocks resize", () => clientA.workspace(workspaceA.id).resources.update({ memory_mb: 8192, apply: false }), [400, 409, 422]);
  await denied("namespace disk ceiling blocks resize", () => clientA.workspace(workspaceA.id).resources.update({ disk_size_mb: 65536, apply: false }), [400, 409, 422]);
  check("rejected resize keeps the original allocation", (await clientA.workspaces.get(workspaceA.id)).resources?.cpus === 2);

  try {
    await until("provider records compute usage", async () => (await admin.billing.entitlement(a)).quota.used > 0, 300_000);
    check("running compute increments namespace usage", true);
  } catch {
    check("running compute increments namespace usage", false, false);
    const usage = await admin.namespaces.usageUnits(a, { from: new Date(Date.now() - 600_000).toISOString(), to: new Date().toISOString(), groupBy: "hour" });
    log("provider metering diagnostic", { usage: usage.data });
  }
  const usedBefore = (await admin.billing.entitlement(a)).quota.used;
  check("Docker metering produced positive usage", usedBefore > 0);
  const usage = await admin.namespaces.usageUnits(a, { from: startedAt.toISOString(), to: new Date().toISOString(), groupBy: "hour" });
  log("metered namespace units", { usage: usage.data });
  check("usage API records CPU and memory consumption", usage.data.totals.records > 0 && usage.data.totals.cpu_time_minutes > 0 && usage.data.totals.memory_gb_minutes > 0);

  // Leave positive headroom and let subsequent usage exhaust it. Setting zero
  // would only test a policy-triggered shutdown, not the actual billing meter.
  // Oblien normalizes policy to two decimal places. Round up so even a small
  // first meter record leaves a positive balance for the next usage tick.
  const allowance = Math.ceil((usedBefore + Math.max(0.01, usedBefore * 0.2)) * 100) / 100;
  await admin.billing.setPolicy(a, policy(allowance));
  const funded = await admin.billing.entitlement(a);
  const effectiveAllowance = funded.quota.limit;
  log("usage-driven exhaustion fixture", { requestedAllowance: allowance, effectiveAllowance, used: funded.quota.used, balance: funded.quota.balance });
  check("quota change preserves metered usage", funded.quota.used >= usedBefore);
  check("customer has positive credit before subsequent usage exhausts it", effectiveAllowance !== null && funded.status === "active" && funded.quota.balance !== null && funded.quota.balance > 0);
  await until("A is credit exhausted by accumulated usage", async () => (await admin.billing.entitlement(a)).status === "credit_exhausted" && (await admin.billing.balance(a)).blocking, 300_000);
  check("exhaustion is visible in entitlement and balance", true);
  check("new usage crossed the configured credit allowance", effectiveAllowance !== null && (await admin.billing.entitlement(a)).quota.used >= effectiveAllowance);
  try {
    await until("provider stops exhausted namespace", async () => cloudWorkspaceStatus(await clientA.workspaces.get(workspaceA.id)) === "stopped", 90_000);
    check("provider stops A on exhaustion", true);
  } catch {
    check("provider stops A on exhaustion", false, false);
    log("explicitly stopping A to continue independent management checks");
    await clientA.workspace(workspaceA.id).stop();
  }
  check("B keeps running when A is exhausted", cloudWorkspaceStatus(await clientB.workspaces.get(workspaceB.id)) === "running" && !(await admin.billing.balance(b)).blocking);
  await denied("exhausted customer cannot restart compute", () => clientA.workspace(workspaceA.id).start(), [402, 403, 409]);
  await denied("exhausted customer cannot create replacement compute", () => clientA.workspaces.create(create(a, "blocked")), [402, 403, 409]);
  check("exhausted customer can still inspect its stopped VM", (await clientA.workspaces.get(workspaceA.id)).id === workspaceA.id);
  await clientA.workspace(workspaceA.id).stop();
  await clientA.workspace(workspaceA.id).stop();
  check("billing-suspended customer can repeat Stop", true);

  await admin.billing.setPolicy(a, policy(100));
  await until("billing restoration", async () => (await admin.billing.entitlement(a)).status === "active" && !(await admin.billing.balance(a)).blocking);
  check("restoring credit does not restart compute implicitly", cloudWorkspaceStatus(await clientA.workspaces.get(workspaceA.id)) === "stopped");
  await clientA.workspace(workspaceA.id).start();
  await waitForCloudDockerWorkspace(clientA, workspaceA.id, a, { signal: abort.signal });
  check("restored customer explicitly resumes the same VM", true);

  log("manual suspension response", { namespace: a, response: await admin.namespaces.suspend(namespaceIds.get(a)!) });
  await suspendedWorkspaceStops(clientA, workspaceA.id, a, "manual suspension stops A");
  await admin.billing.setPolicy(a, policy(200));
  check("credit increase cannot undo a manual suspension", (await admin.namespaces.get(a)).data.status === "suspended" && (await admin.billing.balance(a)).blocking);
  await denied("manual suspension blocks Start despite positive credit", () => clientA.workspace(workspaceA.id).start(), [402, 403, 409]);
  await admin.namespaces.activate(namespaceIds.get(a)!);
  check("explicit reactivation restores access without starting the VM", (await admin.namespaces.get(a)).data.status === "active" && !(await admin.billing.balance(a)).blocking && cloudWorkspaceStatus(await clientA.workspaces.get(workspaceA.id)) === "stopped");
  await clientA.workspace(workspaceA.id).start();
  await waitForCloudDockerWorkspace(clientA, workspaceA.id, a, { signal: abort.signal });
  check("manually suspended VM starts only after reactivation", true);
  log("second manual suspension response", { namespace: a, response: await admin.namespaces.suspend(namespaceIds.get(a)!) });
  await suspendedWorkspaceStops(clientA, workspaceA.id, a, "second manual suspension stops A");
  await clientA.workspace(workspaceA.id).stop();
  await clientA.workspace(workspaceA.id).stop();
  check("manually suspended customer can repeat Stop", true);
  await deleteCloudWorkspace(clientA.workspace(workspaceA.id));
  await until("A disappears from the scoped workspace list", async () => (await clientA.workspaces.list()).workspaces.length === 0, 60_000);
  check("suspended customer can delete resources", (await clientA.workspaces.list()).workspaces.length === 0);
  check("B remains available after A cleanup", cloudWorkspaceStatus(await clientB.workspaces.get(workspaceB.id)) === "running");
  await admin.billing.setPolicy(b, policy(0));
  await until("B stops for billing-suspended deletion check", async () => (await admin.billing.balance(b)).blocking && cloudWorkspaceStatus(await clientB.workspaces.get(workspaceB.id)) === "stopped");
  await clientB.workspace(workspaceB.id).stop();
  await clientB.workspace(workspaceB.id).stop();
  await deleteCloudWorkspace(clientB.workspace(workspaceB.id));
  await until("B disappears from the scoped workspace list", async () => (await clientB.workspaces.list()).workspaces.length === 0, 60_000);
  check("billing-suspended customer can inspect, repeat Stop and Delete", (await clientB.workspaces.list()).workspaces.length === 0);
} catch (error) {
  check("all lifecycle checks completed", false, false);
  log("test failed", { message: error instanceof Error ? error.message.replace(/([?&](?:token|access_token)=)[^&\s]+/gi, "$1[redacted]") : "Unknown failure", status: (error as { status?: number }).status });
  process.exitCode = 1;
} finally {
  for (const [slug, namespace] of pages) {
    try {
      const page = (await admin.pages.get(slug)).page;
      if (page.namespace !== namespace || !slug.startsWith(`${tag}-`)) throw new Error("Test Page identity changed");
      await admin.pages.delete(slug);
      pages.delete(slug);
    } catch (error) {
      if ((error as { status?: number }).status === 404) pages.delete(slug);
      else { log("Page cleanup needs retry", { slug }); process.exitCode = 1; }
    }
  }
  for (const [namespace, id] of namespaceIds) {
    try {
      const current = await admin.namespaces.get(id);
      if (current.data.slug !== namespace || !namespace.startsWith(`${tag}-`)) throw new Error("Test namespace identity changed");
      await admin.namespaces.delete(id, { deleteWorkspaces: true });
      namespaceIds.delete(namespace);
    } catch (error) {
      if ((error as { status?: number }).status === 404) namespaceIds.delete(namespace);
      else { log("cleanup needs retry", { namespace, manifest: join(directory, "resources.json") }); process.exitCode = 1; }
    }
  }
  await save();
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  log("finished", { passed: report.filter(item => item.passed).length, failed: report.filter(item => !item.passed).length,
    cleanupComplete: namespaceIds.size === 0 && pages.size === 0, report: join(directory, "report.json") });
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
