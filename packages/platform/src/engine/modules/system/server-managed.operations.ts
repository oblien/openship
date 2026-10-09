import { createHash } from "node:crypto";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import ssh2 from "ssh2";
import { AppError } from "@repo/core";
import { repos } from "@repo/db";
import {
  cloudWorkspaceStatus,
  managedProcessState,
  readManagedProcessStatus,
  waitForManagedProcess,
} from "@repo/adapters";
import type {
  ManagedServerResourceSchemas,
  ManagedSshStatus,
  ManagedWorkload,
} from "@repo/contracts";
import type { ResourceServices } from "../../../resource-operations";
import type { ExecutionContext } from "../../../context";
import { env } from "../../config/env";
import {
  managedConnection,
  mutateManagedServer,
  managedProviderCall,
  requireProviderSuccess,
  auditManagedControl,
  type ManagedConnection,
} from "./managed-server-access";

type Workload = Awaited<ReturnType<ManagedConnection["workspace"]["workloads"]["get"]>>;
const text = (value: unknown) => (typeof value === "string" ? value : null);
const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const manualPrefix = "openship-manual-";
const missing = (error: unknown) => (error as { status?: number })?.status === 404;

function sshStatus(
  value: Awaited<ReturnType<ManagedConnection["workspace"]["ssh"]["status"]>>,
): ManagedSshStatus {
  const connection = value.connection;
  return {
    enabled: flag(value.ssh_enabled),
    keyConfigured: flag(value.ssh_key_set),
    passwordConfigured: flag(value.password_auth_enabled),
    requiresIdentityAccess: value.requires_account_access === true,
    connection:
      !value.requires_account_access &&
      connection &&
      [connection.user, connection.host, connection.bastion, connection.command].every(
        (v) => typeof v === "string",
      )
        ? {
            user: connection.user,
            host: connection.host,
            bastion: connection.bastion,
            command: connection.command,
          }
        : null,
  };
}
async function runtimeStatus(connection: ManagedConnection) {
  const result = await connection.workspace.apiAccess.status();
  return { enabled: flag(result.enabled), running: flag(result.is_running) };
}
async function runtimeCredential(connection: ManagedConnection) {
  const result = await connection.workspace.apiAccess.getToken();
  // A trusted provider response still has to be for THIS workspace. Never
  // forward an accidentally returned namespace/account credential to the UI.
  let claims: Record<string, unknown> = {};
  try {
    if (typeof result.token === "string")
      claims = JSON.parse(Buffer.from(result.token.split(".")[1] ?? "", "base64url").toString());
  } catch {
    /* validated below */
  }
  if (
    !result.token ||
    claims.type !== "workspace" ||
    claims.workspace_id !== connection.binding.workspaceId ||
    typeof claims.token !== "string" ||
    claims.token.length < 16 ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  )
    throw new AppError(
      "The provider did not return a valid connection for this server",
      502,
      "MANAGED_CREDENTIAL_UNAVAILABLE",
    );
  return {
    endpoint: env.OBLIEN_RUNTIME_URL.replace(/\/$/, ""),
    token: result.token,
    revision: digest(claims.token),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}
function boundedLogs(result: { success?: unknown; logs?: unknown }, tail: number) {
  requireProviderSuccess(result);
  if (typeof result.logs !== "string")
    throw new AppError("The provider did not return server logs", 502, "MANAGED_LOGS_UNAVAILABLE");
  const lines = result.logs.split(/\r?\n/);
  const selected = lines.slice(-tail).join("\n");
  return {
    logs: selected.slice(-65536),
    truncated: lines.length > tail || selected.length > 65536,
  };
}
function manualWorkload(workload: Workload, connection: ManagedConnection) {
  return (
    workload.id.startsWith(manualPrefix) &&
    workload.labels?.["openship.manual"] === "v1" &&
    workload.labels?.["openship.workspace"] === connection.binding.workspaceId &&
    !workload.labels?.["openship.project"] &&
    !workload.labels?.["openship.deployment"]
  );
}
function presentWorkload(
  workload: Workload,
  connection: ManagedConnection,
  projects: ReadonlySet<string> = new Set(),
): ManagedWorkload {
  let state = "unknown";
  try {
    state = managedProcessState(workload);
  } catch {
    // diagnostics-ignore: The status read is observed separately; unknown is an explicit UI state, never stopped.
  }
  const manual = manualWorkload(workload, connection);
  const project = workload.labels?.["openship.project"];
  return {
    id: workload.id,
    name: text(workload.name) ?? workload.id,
    state,
    restartPolicy: text(workload.restart_policy),
    source: manual ? "manual" : project ? "project" : "system",
    projectId: project && projects.has(project) ? project : null,
    manageable: manual,
  };
}
async function readWorkload(connection: ManagedConnection, id: string) {
  const saved = await connection.workspace.workloads.get(id);
  if (saved.id !== id)
    throw new AppError(
      "The provider returned a different process",
      502,
      "MANAGED_WORKLOAD_IDENTITY_MISMATCH",
    );
  return saved;
}

const controls: ResourceServices<typeof ManagedServerResourceSchemas> = {
  async managedInfo(ctx, id) {
    const { provider, binding } = await managedConnection(ctx, id);
    const ws = provider.workspace;
    return {
      workspaceId: binding.workspaceId!,
      image: ws.image,
      state: cloudWorkspaceStatus(ws),
      mode: text(ws.mode),
      operatingSystem: ws.base_os
        ? `${ws.base_os.distribution} ${ws.base_os.version}`.trim()
        : null,
      restartPolicy: text(ws.lifecycle?.restart_policy),
      resources: provider.allocation,
    };
  },
  async managedBootLogs(ctx, id, input) {
    const { workspace } = await managedConnection(ctx, id);
    return boundedLogs(
      await workspace.logs.get({ source: "boot", tail_lines: input.tail }),
      input.tail,
    );
  },
  async managedSshStatus(ctx, id) {
    return sshStatus(await (await managedConnection(ctx, id)).workspace.ssh.status());
  },
  async setManagedSsh(ctx, id, input) {
    return mutateManagedServer(ctx, id, input.enabled, async ({ workspace }) => {
      const before = sshStatus(await workspace.ssh.status());
      if (before.enabled === input.enabled) return { status: before, initialPassword: null };
      if (before.enabled !== input.expectedEnabled)
        throw new AppError(
          "SSH access changed. Refresh before changing it.",
          409,
          "MANAGED_SSH_CHANGED",
        );
      const result = await (input.enabled ? workspace.ssh.enable() : workspace.ssh.disable());
      requireProviderSuccess(result);
      const after = sshStatus(await workspace.ssh.status());
      if (after.enabled !== input.enabled)
        throw new AppError(
          "The SSH change could not be confirmed. Refresh its status.",
          502,
          "MANAGED_CHANGE_UNCONFIRMED",
        );
      auditManagedControl(ctx, id, input.enabled ? "ssh.enable" : "ssh.disable");
      return { status: after, initialPassword: input.enabled ? text(result.ssh_password) : null };
    });
  },
  async setManagedSshKey(ctx, id, input) {
    const key = input.publicKey.trim();
    const parsed = ssh2.utils.parseKey(key);
    if (
      key.includes("\n") ||
      key.includes("\r") ||
      !/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521)) [A-Za-z0-9+/]+=*(?: .*)?$/.test(key) ||
      parsed instanceof Error ||
      Array.isArray(parsed)
    )
      throw new AppError(
        "Enter one valid OpenSSH public key, not a private key",
        400,
        "INVALID_SSH_PUBLIC_KEY",
      );
    return mutateManagedServer(ctx, id, false, async ({ workspace }) => {
      requireProviderSuccess(await workspace.ssh.setKey({ public_key: key }));
      const after = sshStatus(await workspace.ssh.status());
      if (after.keyConfigured !== true)
        throw new AppError(
          "The provider did not confirm the SSH key",
          502,
          "MANAGED_CHANGE_UNCONFIRMED",
        );
      auditManagedControl(ctx, id, "ssh.set_key");
      return after;
    });
  },
  async setManagedSshPassword(ctx, id, input) {
    return mutateManagedServer(ctx, id, false, async ({ workspace }) => {
      requireProviderSuccess(await workspace.ssh.setPassword({ password: input.password }));
      auditManagedControl(ctx, id, "ssh.set_password");
      return sshStatus(await workspace.ssh.status());
    });
  },
  async managedSshConnection(ctx, id) {
    return mutateManagedServer(ctx, id, true, async ({ workspace }) => {
      const result = await workspace.ssh.connection();
      requireProviderSuccess(result);
      if (
        !result.ssh?.password ||
        !Number.isFinite(Date.parse(result.expires_at)) ||
        Date.parse(result.expires_at) <= Date.now()
      )
        throw new AppError(
          "The provider did not return a valid SSH connection",
          502,
          "MANAGED_CREDENTIAL_UNAVAILABLE",
        );
      auditManagedControl(ctx, id, "ssh.connection");
      return {
        host: result.ssh.host,
        port: result.ssh.port,
        username: result.ssh.username,
        password: result.ssh.password,
        hostKeyFingerprint: result.ssh.host_key_fingerprint,
        expiresAt: result.expires_at,
      };
    });
  },
  async managedRuntimeStatus(ctx, id) {
    return runtimeStatus(await managedConnection(ctx, id));
  },
  async enableManagedRuntime(ctx, id) {
    return mutateManagedServer(ctx, id, true, async (connection) => {
      if ((await runtimeStatus(connection)).enabled !== true) {
        const result = await connection.workspace.apiAccess.enable();
        requireProviderSuccess(result);
        connection.client.workspaces.invalidateRuntime(connection.binding.workspaceId!);
        auditManagedControl(ctx, id, "runtime.enable");
      }
      const after = await runtimeStatus(connection);
      if (after.enabled !== true)
        throw new AppError(
          "The Runtime API has not become available. Refresh its status.",
          502,
          "MANAGED_CHANGE_UNCONFIRMED",
        );
      return after;
    });
  },
  async managedRuntimeCredential(ctx, id) {
    return mutateManagedServer(ctx, id, true, async (connection) => {
      const credential = await runtimeCredential(connection);
      auditManagedControl(ctx, id, "runtime.reveal_token");
      return credential;
    });
  },
  async rotateManagedRuntimeCredential(ctx, id, input) {
    return mutateManagedServer(ctx, id, true, async (connection) => {
      const before = await runtimeCredential(connection);
      if (before.revision !== input.expectedRevision)
        throw new AppError(
          "The token changed. Reveal the current token before rotating it again.",
          409,
          "MANAGED_RUNTIME_TOKEN_CHANGED",
        );
      try {
        requireProviderSuccess(await connection.workspace.apiAccess.rotateToken());
      } finally {
        connection.client.workspaces.invalidateRuntime(connection.binding.workspaceId!);
      }
      const after = await runtimeCredential(connection);
      if (after.revision === before.revision)
        throw new AppError(
          "The provider did not confirm token rotation. Reveal its current token before retrying.",
          502,
          "MANAGED_CHANGE_UNCONFIRMED",
        );
      auditManagedControl(ctx, id, "runtime.rotate_token");
      return after;
    });
  },
  async managedWorkloads(ctx, id) {
    const connection = await managedConnection(ctx, id);
    const saved = await connection.workspace.workloads.list();
    const projects = new Set(
      (await repos.project.listByWorkspace(connection.workspaceId, ctx.organizationId)).map(
        (p) => p.id,
      ),
    );
    const rows = saved.slice(0, 100);
    const workloads: ManagedWorkload[] = new Array(rows.length);
    let next = 0;
    // Bound live reads; saved workload state can be stale after a VM restart.
    await Promise.all(
      Array.from({ length: Math.min(4, rows.length) }, async () => {
        for (let index = next++; index < rows.length; index = next++) {
          const row = rows[index]!;
          let live: Workload;
          try {
            live = await readManagedProcessStatus(connection.workspace.workloads, row);
          } catch {
            // Do not report provider request bodies/headers or process environments.
            observeCaughtError(
              new Error("Managed process status could not be read"),
              "platform/engine/modules/system/server-managed.operations",
            );
            live = { ...row, state: "unknown", status: "unknown" };
          }
          workloads[index] = presentWorkload(live, connection, projects);
        }
      }),
    );
    return { workloads, truncated: saved.length > rows.length };
  },
  async managedWorkloadLogs(ctx, id, input) {
    const connection = await managedConnection(ctx, id);
    await readWorkload(connection, input.workloadId);
    return boundedLogs(
      await connection.workspace.workloads.logs(input.workloadId, { tail: input.tail }),
      input.tail,
    );
  },
  async createManagedWorkload(ctx, id, input) {
    const environmentKeys = input.environment.map((value) => value.slice(0, value.indexOf("=")));
    if (new Set(environmentKeys).size !== environmentKeys.length)
      throw new AppError(
        "Each environment variable must be specified once",
        400,
        "DUPLICATE_ENVIRONMENT_KEY",
      );
    return mutateManagedServer(ctx, id, true, async (connection) => {
      const workloadId = `${manualPrefix}${input.idempotencyKey}`;
      const request = digest(
        JSON.stringify([
          input.name,
          input.command,
          input.workingDirectory,
          input.environment,
          input.restartPolicy,
        ]),
      );
      const workloadApi = connection.workspace.workloads;
      const validate = (row: Workload) => {
        if (
          row.id !== workloadId ||
          !manualWorkload(row, connection) ||
          row.labels?.["openship.request"] !== request
        )
          throw new AppError(
            "This request ID belongs to a different process. Refresh before creating another.",
            409,
            "MANAGED_WORKLOAD_CONFLICT",
          );
        return row;
      };
      let saved: Workload | null = null;
      try {
        saved = validate(await readWorkload(connection, workloadId));
      } catch (error) {
        if (!missing(error)) throw error;
      }
      if (!saved) {
        try {
          validate(
            await workloadApi.create({
              id: workloadId,
              name: input.name,
              cmd: ["/bin/sh", "-lc", input.command],
              working_dir: input.workingDirectory,
              env: input.environment,
              restart_policy: input.restartPolicy,
              enabled: false,
              labels: {
                "openship.manual": "v1",
                "openship.workspace": connection.binding.workspaceId!,
                "openship.request": request,
              },
            }),
          );
        } catch (error) {
          // A lost create reply must recover the same ID, never a duplicate.
          try {
            saved = validate(await readWorkload(connection, workloadId));
          } catch {
            throw error;
          }
        }
        saved ??= validate(await readWorkload(connection, workloadId));
        auditManagedControl(ctx, id, "workload.create", { workloadId });
      }
      return presentWorkload(await readManagedProcessStatus(workloadApi, saved), connection);
    });
  },
  async controlManagedWorkload(ctx, id, input) {
    return mutateManagedServer(ctx, id, input.action === "start", async (connection) => {
      const api = connection.workspace.workloads;
      let saved: Workload;
      try {
        saved = await readWorkload(connection, input.workloadId);
      } catch (error) {
        if (
          missing(error) &&
          input.action === "delete" &&
          input.workloadId.startsWith(manualPrefix)
        )
          return { ok: true, workload: null };
        throw error;
      }
      if (!manualWorkload(saved, connection))
        throw new AppError(
          "Use the project's deployment controls or SSH settings for this managed process",
          409,
          "MANAGED_WORKLOAD_PROTECTED",
        );
      if (input.action === "delete") {
        requireProviderSuccess(await api.delete(saved.id));
        try {
          await api.get(saved.id);
          throw new AppError(
            "The provider still lists this process. Refresh before retrying deletion.",
            502,
            "MANAGED_CHANGE_UNCONFIRMED",
          );
        } catch (error) {
          if (!missing(error)) throw error;
        }
        auditManagedControl(ctx, id, "workload.delete", { workloadId: saved.id });
        return { ok: true, workload: null };
      }
      const read = async () =>
        readManagedProcessStatus(api, await readWorkload(connection, saved.id));
      const expected = input.action === "start" ? "running" : "stopped";
      const current = await read();
      if (
        managedProcessState(current) === expected &&
        (input.action === "start" || current.enabled === false)
      )
        return { ok: true, workload: presentWorkload(current, connection) };
      requireProviderSuccess(
        await (input.action === "start" ? api.start(saved.id) : api.stop(saved.id)),
      );
      await waitForManagedProcess(read, expected);
      auditManagedControl(ctx, id, `workload.${input.action}`, { workloadId: saved.id });
      return { ok: true, workload: presentWorkload(await read(), connection) };
    });
  },
};

/** Preserve each typed operation while applying the shared provider error boundary. */
export const serverManagedControls = Object.fromEntries(
  Object.entries(controls).map(([key, operation]) => [
    key,
    (ctx: ExecutionContext, id: string, input: never) =>
      managedProviderCall(() => operation(ctx, id, input)),
  ]),
) as typeof controls;
