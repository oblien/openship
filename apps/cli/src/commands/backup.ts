/**
 * `openship backup` — policies, runs, restores, and destinations.
 *
 * Grounded in apps/api/src/modules/backups/backup.routes.ts and
 * apps/api/src/modules/backup-destinations/destination.routes.ts.
 * Every subcommand cites the route it hits above its action.
 */
import { Command } from "commander";
import ora from "ora";
import { readFileSync } from "node:fs";
import { ApiError, apiRequest } from "../lib/api-client";
import { sseRequest } from "../lib/sse";
import { err, info, isJsonMode, ok, printJson, printTable } from "../lib/output";

type Row = Record<string, unknown>;
interface Envelope<T> {
  data: T;
}

async function guard(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
    err(`\n  ${msg}\n`);
    process.exit(1);
  }
}

/** Print an envelope's `data` as a table (or raw JSON in --json mode). */
function show(data: unknown, columns?: string[]): void {
  if (isJsonMode()) {
    printJson(data);
    return;
  }
  const rows = Array.isArray(data) ? (data as Row[]) : [data as Row];
  printTable(rows.map((r) => pick(r, columns)), columns);
}

/** Narrow an object to the given keys (present ones only) for compact tables. */
function pick(row: Row, keys?: string[]): Row {
  if (!keys) return row;
  const out: Row = {};
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}

function toInt(v: string | undefined, label: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${label} must be an integer`);
  return n;
}

function fmtBytes(n: number | null | undefined): string {
  if (!n || n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/**
 * Follow a run/restore SSE channel to a terminal state. The API emits
 * `snapshot` first, then `transition`/`progress`, then `complete`
 * (backup.controller.ts streamRun / streamRestore). Returns the final
 * status; the caller decides the exit code.
 */
async function followStream(path: string, label: string): Promise<string> {
  const spinner = isJsonMode() ? null : ora(`${label}: connecting…`).start();
  let status = "unknown";
  try {
    for await (const ev of sseRequest(path)) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (isJsonMode()) printJson(payload);

      const type = (payload.type as string) ?? ev.event;
      if (type === "snapshot") {
        const rec = (payload.run ?? payload.restore) as Row | undefined;
        status = (rec?.status as string) ?? status;
        if (spinner) spinner.text = `${label}: ${status}`;
      } else if (type === "transition") {
        status = (payload.status as string) ?? status;
        const bytes = (payload.bytesTransferred ?? payload.bytesRestored) as number | undefined;
        if (spinner) spinner.text = `${label}: ${status}${bytes ? ` (${fmtBytes(bytes)})` : ""}`;
      } else if (type === "progress") {
        const artifact = (payload.currentArtifact as string) ?? "working";
        const bytes = payload.bytesTransferred as number | undefined;
        if (spinner) spinner.text = `${label}: ${artifact} ${fmtBytes(bytes)}`.trimEnd();
      } else if (type === "complete") {
        status = (payload.status as string) ?? status;
        const errMsg = payload.errorMessage as string | undefined;
        if (status === "succeeded") spinner?.succeed(`${label} succeeded`);
        else spinner?.fail(`${label} ${status}${errMsg ? `: ${errMsg}` : ""}`);
        break;
      }
    }
  } catch (e) {
    spinner?.stop();
    throw e;
  }
  spinner?.stop();
  return status;
}

// ─── policy ────────────────────────────────────────────────────────────────

const policyCmd = new Command("policy").description("Backup policies (schedules) for a project");

policyCmd
  .command("list")
  .description("List backup policies for a project")
  // GET /api/projects/:projectId/backup-policies
  .requiredOption("--project <id>", "Project ID")
  .action((opts) =>
    guard(async () => {
      const { data } = await apiRequest<Envelope<Row[]>>(
        `/projects/${encodeURIComponent(opts.project)}/backup-policies`,
      );
      show(data, [
        "id",
        "enabled",
        "cronExpression",
        "triggerOnPreDeploy",
        "serviceId",
        "destinationId",
        "payloadKind",
      ]);
    }),
  );

policyCmd
  .command("create")
  .description("Create a backup policy for a project")
  // POST /api/projects/:projectId/backup-policies
  .requiredOption("--project <id>", "Project ID")
  .requiredOption("--destination <id>", "Backup destination ID")
  .option("--service <id>", "Scope the policy to a single service")
  .option("--cron <expr>", "Cron schedule (e.g. '0 3 * * *')")
  .option("--pre-deploy", "Also run this backup before each deploy")
  .option("--retain-count <n>", "Keep at most N runs")
  .option("--retain-days <n>", "Keep runs for N days")
  .option("--payload-kind <kind>", "Payload kind (default: auto)")
  .option("--payload-config <json>", "Payload config as a JSON object")
  .option("--pre-hook <cmd>", "Shell command run before the backup")
  .option("--post-hook <cmd>", "Shell command run after the backup")
  .option("--disabled", "Create the policy disabled")
  .action((opts) =>
    guard(async () => {
      let payloadConfig: Record<string, unknown> | undefined;
      if (opts.payloadConfig) {
        try {
          payloadConfig = JSON.parse(opts.payloadConfig);
        } catch {
          throw new Error("--payload-config must be valid JSON");
        }
      }
      const body = {
        destinationId: opts.destination,
        serviceId: opts.service ?? null,
        cronExpression: opts.cron,
        triggerOnPreDeploy: opts.preDeploy || undefined,
        retainCount: toInt(opts.retainCount, "--retain-count"),
        retainDays: toInt(opts.retainDays, "--retain-days"),
        payloadKind: opts.payloadKind,
        payloadConfig,
        preHook: opts.preHook,
        postHook: opts.postHook,
        enabled: opts.disabled ? false : undefined,
      };
      const { data } = await apiRequest<Envelope<Row>>(
        `/projects/${encodeURIComponent(opts.project)}/backup-policies`,
        { method: "POST", body: JSON.stringify(body) },
      );
      ok(`\n  Policy created: ${data.id}\n`);
      show(data, ["id", "enabled", "cronExpression", "triggerOnPreDeploy", "destinationId"]);
    }),
  );

policyCmd
  .command("run")
  .description("Trigger a policy's backup now")
  // POST /api/backup-policies/:policyId/run  → { runId }
  .argument("<policyId>", "Backup policy ID")
  .option("--follow", "Stream the run to completion")
  .action((policyId, opts) =>
    guard(async () => {
      const { data } = await apiRequest<Envelope<{ runId: string }>>(
        `/backup-policies/${encodeURIComponent(policyId)}/run`,
        { method: "POST", body: JSON.stringify({}) },
      );
      ok(`\n  Backup started: run ${data.runId}\n`);
      if (opts.follow) {
        const status = await followStream(`/backup-runs/${data.runId}/stream`, "backup");
        if (status !== "succeeded") process.exit(1);
      } else if (isJsonMode()) {
        printJson(data);
      } else {
        info(`  Follow it with:  openship backup run get ${data.runId} --follow\n`);
      }
    }),
  );

// ─── run ─────────────────────────────────────────────────────────────────────

const runCmd = new Command("run").description("Backup runs (executions)");

runCmd
  .command("list")
  .description("List backup runs for a project")
  // GET /api/projects/:projectId/backup-runs?serviceId=&limit=
  .requiredOption("--project <id>", "Project ID")
  .option("--service <id>", "Filter to a single service")
  .option("--limit <n>", "Max rows (default 50)")
  .action((opts) =>
    guard(async () => {
      const qs = new URLSearchParams();
      if (opts.service) qs.set("serviceId", opts.service);
      if (opts.limit) qs.set("limit", String(toInt(opts.limit, "--limit")));
      const suffix = qs.toString() ? `?${qs}` : "";
      const { data } = await apiRequest<Envelope<Row[]>>(
        `/projects/${encodeURIComponent(opts.project)}/backup-runs${suffix}`,
      );
      show(data, [
        "id",
        "status",
        "sourceKind",
        "serviceId",
        "triggeredBy",
        "bytesTransferred",
        "startedAt",
        "finishedAt",
      ]);
    }),
  );

runCmd
  .command("get")
  .description("Show one run (optionally stream it)")
  // GET /api/backup-runs/:runId  (+ /stream for --follow)
  .argument("<runId>", "Backup run ID")
  .option("--follow", "Stream progress to completion")
  .action((runId, opts) =>
    guard(async () => {
      if (opts.follow) {
        const status = await followStream(`/backup-runs/${encodeURIComponent(runId)}/stream`, "backup");
        if (status !== "succeeded") process.exit(1);
        return;
      }
      const { data } = await apiRequest<Envelope<Row>>(`/backup-runs/${encodeURIComponent(runId)}`);
      show(data);
    }),
  );

runCmd
  .command("protect")
  .description("Protect a run from retention pruning (or release it)")
  // POST /api/backup-runs/:runId/protect  { until?, protected? }
  .argument("<runId>", "Backup run ID")
  .option("--until <iso>", "Protect until this ISO timestamp")
  .option("--release", "Clear the protection so retention can prune it")
  .action((runId, opts) =>
    guard(async () => {
      const body = opts.release
        ? { protected: false }
        : opts.until
          ? { until: opts.until }
          : { protected: true };
      const { data } = await apiRequest<Envelope<{ ok: boolean; retentionLockedUntil: string | null }>>(
        `/backup-runs/${encodeURIComponent(runId)}/protect`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (isJsonMode()) printJson(data);
      else if (data.retentionLockedUntil) ok(`\n  Protected until ${data.retentionLockedUntil}\n`);
      else ok(`\n  Protection cleared\n`);
    }),
  );

runCmd
  .command("restore")
  .description("Prepare a restore from a run (stages it; apply separately)")
  // POST /api/backup-runs/:runId/restore/prepare → { restoreId, confirmationToken }
  .argument("<runId>", "Backup run ID to restore from")
  .option("--mode <mode>", "in_place (default) or to_fork", "in_place")
  .option("--fork-server <id>", "Target mail server ID (required for --mode to_fork)")
  .option("--follow", "Stream the preparation phase")
  .action((runId, opts) =>
    guard(async () => {
      if (opts.mode !== "in_place" && opts.mode !== "to_fork") {
        throw new Error("--mode must be 'in_place' or 'to_fork'");
      }
      const body: Record<string, unknown> = { mode: opts.mode };
      if (opts.mode === "to_fork") body.forkMailServerId = opts.forkServer ?? null;
      const { data } = await apiRequest<Envelope<{ restoreId: string; confirmationToken: string }>>(
        `/backup-runs/${encodeURIComponent(runId)}/restore/prepare`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (isJsonMode()) printJson(data);
      else {
        ok(`\n  Restore staged: ${data.restoreId}\n`);
        info(`  Confirmation token: ${data.confirmationToken}`);
        info(
          `  Apply it with:  openship backup restore apply ${data.restoreId} --token ${data.confirmationToken}\n`,
        );
      }
      if (opts.follow) {
        await followStream(`/backup-restores/${data.restoreId}/stream`, "restore");
      }
    }),
  );

// ─── restore ───────────────────────────────────────────────────────────────

const restoreCmd = new Command("restore").description("Manage staged restores");

restoreCmd
  .command("apply")
  .description("Apply a staged restore (destructive)")
  // POST /api/backup-restores/:restoreId/apply  { confirmationToken }
  .argument("<restoreId>", "Restore ID from `backup run restore`")
  .requiredOption("--token <token>", "Confirmation token from prepare")
  .option("--follow", "Stream the restore to completion")
  .action((restoreId, opts) =>
    guard(async () => {
      await apiRequest<Envelope<{ ok: boolean }>>(
        `/backup-restores/${encodeURIComponent(restoreId)}/apply`,
        { method: "POST", body: JSON.stringify({ confirmationToken: opts.token }) },
      );
      ok(`\n  Restore applying: ${restoreId}\n`);
      if (opts.follow) {
        const status = await followStream(`/backup-restores/${restoreId}/stream`, "restore");
        if (status !== "succeeded") process.exit(1);
      }
    }),
  );

restoreCmd
  .command("cancel")
  .description("Cancel a staged or in-flight restore")
  // POST /api/backup-restores/:restoreId/cancel
  .argument("<restoreId>", "Restore ID")
  .action((restoreId) =>
    guard(async () => {
      await apiRequest<Envelope<{ ok: boolean }>>(
        `/backup-restores/${encodeURIComponent(restoreId)}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
      );
      ok(`\n  Restore cancelled: ${restoreId}\n`);
    }),
  );

restoreCmd
  .command("get")
  .description("Show one restore (optionally stream it)")
  // GET /api/backup-restores/:restoreId  (+ /stream for --follow)
  .argument("<restoreId>", "Restore ID")
  .option("--follow", "Stream progress to completion")
  .action((restoreId, opts) =>
    guard(async () => {
      if (opts.follow) {
        const status = await followStream(
          `/backup-restores/${encodeURIComponent(restoreId)}/stream`,
          "restore",
        );
        if (status !== "succeeded") process.exit(1);
        return;
      }
      const { data } = await apiRequest<Envelope<Row>>(
        `/backup-restores/${encodeURIComponent(restoreId)}`,
      );
      show(data);
    }),
  );

// ─── destination ─────────────────────────────────────────────────────────────

const destinationCmd = new Command("destination").description("Backup destinations (storage targets)");

destinationCmd
  .command("list")
  .description("List backup destinations")
  // GET /api/backup-destinations
  .action(() =>
    guard(async () => {
      const { data } = await apiRequest<Envelope<Row[]>>("/backup-destinations");
      show(data, [
        "id",
        "name",
        "kind",
        "bucket",
        "endpoint",
        "isDefault",
        "lastVerifiedAt",
        "lastVerifyError",
      ]);
    }),
  );

destinationCmd
  .command("create")
  .description("Create a backup destination")
  // POST /api/backup-destinations
  .requiredOption("--name <name>", "Display name")
  .requiredOption("--kind <kind>", "s3_compatible | sftp | openship_server | local")
  .option("--endpoint <url>", "Endpoint URL / absolute path (local)")
  .option("--region <region>", "S3 region")
  .option("--bucket <bucket>", "S3 bucket")
  .option("--path-prefix <prefix>", "Key/path prefix")
  .option("--ssh-host <host>", "SFTP host")
  .option("--ssh-port <port>", "SFTP port")
  .option("--ssh-user <user>", "SFTP user")
  .option("--server <id>", "Server ID (openship_server kind)")
  .option("--access-key-id <id>", "S3 access key ID")
  .option("--secret-access-key <key>", "S3 secret access key")
  .option("--sftp-password <pw>", "SFTP password")
  .option("--sftp-private-key <key>", "SFTP private key (raw)")
  .option("--sftp-private-key-file <path>", "Read the SFTP private key from a file")
  .option("--sftp-key-passphrase <pw>", "SFTP private key passphrase")
  .option("--default", "Mark as the default destination")
  .action((opts) =>
    guard(async () => {
      let sftpPrivateKey: string | undefined = opts.sftpPrivateKey;
      if (opts.sftpPrivateKeyFile) {
        try {
          sftpPrivateKey = readFileSync(opts.sftpPrivateKeyFile, "utf8");
        } catch {
          throw new Error(`Cannot read key file: ${opts.sftpPrivateKeyFile}`);
        }
      }
      const body = {
        name: opts.name,
        kind: opts.kind,
        endpoint: opts.endpoint,
        region: opts.region,
        bucket: opts.bucket,
        pathPrefix: opts.pathPrefix,
        sshHost: opts.sshHost,
        sshPort: toInt(opts.sshPort, "--ssh-port"),
        sshUser: opts.sshUser,
        serverId: opts.server,
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sftpPassword: opts.sftpPassword,
        sftpPrivateKey,
        sftpKeyPassphrase: opts.sftpKeyPassphrase,
        isDefault: opts.default || undefined,
      };
      const { data } = await apiRequest<Envelope<Row>>("/backup-destinations", {
        method: "POST",
        body: JSON.stringify(body),
      });
      ok(`\n  Destination created: ${data.id}\n`);
      show(data, ["id", "name", "kind", "bucket", "endpoint", "isDefault"]);
    }),
  );

destinationCmd
  .command("preflight")
  .description("Verify a destination (write + read + delete a probe object)")
  // POST /api/backup-destinations/:id/preflight → { ok, reason? }
  .argument("<destinationId>", "Destination ID")
  .action((destinationId) =>
    guard(async () => {
      const spinner = isJsonMode() ? null : ora("Running preflight…").start();
      const { data } = await apiRequest<Envelope<{ ok: boolean; reason?: string }>>(
        `/backup-destinations/${encodeURIComponent(destinationId)}/preflight`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (isJsonMode()) {
        printJson(data);
        return;
      }
      if (data.ok) spinner?.succeed("Destination reachable");
      else {
        spinner?.fail(`Preflight failed: ${data.reason ?? "unknown"}`);
        process.exit(1);
      }
    }),
  );

// ─── parent ────────────────────────────────────────────────────────────────

export const backupCommand = new Command("backup")
  .description("Manage backups: policies, runs, restores, destinations")
  .addCommand(policyCmd)
  .addCommand(runCmd)
  .addCommand(restoreCmd)
  .addCommand(destinationCmd);
