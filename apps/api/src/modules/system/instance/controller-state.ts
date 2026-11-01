import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { randomUUID } from "node:crypto";
import { db, eq, schema, sql, type DatabaseTransaction } from "@repo/db";
import {
  instanceEnvironment,
  INSTANCE_ENVIRONMENT_KEYS,
  type ControllerRole,
  type InstanceConnection,
} from "@repo/core";
import { env } from "@repo/platform/engine/config/env";
import { decrypt, encrypt } from "@repo/platform/engine/lib/encryption";

export type ControllerState = typeof schema.instanceController.$inferSelect;

export async function controllerState(): Promise<ControllerState> {
  const [existing] = await db.select().from(schema.instanceController).limit(1);
  if (existing) return existing;
  await db.transaction(async (tx) => {
    // A fresh API-only receiver has never opened Settings or bootstrapped a
    // user. Seed the singleton required by the shared archive restore lock
    // before saving its recovery snapshot; do not start workers to create it.
    await tx.insert(schema.instanceSettings).values({ id: "default" }).onConflictDoNothing();
    await tx
      .insert(schema.instanceController)
      .values({
        installationId: randomUUID(),
        projectId: process.env.OPENSHIP_INSTANCE_PROJECT_ID || null,
        // A provisioned receiver must NEVER run startup reconciliation or workers
        // before its source relinquishes authority, including after a restart.
        role: process.env.OPENSHIP_INSTANCE_RECEIVE_TOKEN ? "receiving" : "active",
      })
      .onConflictDoNothing();
  });
  const [created] = await db.select().from(schema.instanceController).limit(1);
  if (!created) throw new Error("Could not read this installation’s controller state.");
  return created;
}

export async function controllerIsActive(): Promise<boolean> {
  if (env.CLOUD_MODE) return true;
  const state = await controllerState();
  return state.role === "active" && controllerEnvironmentReady(state);
}

export function controllerEnvironmentReady(state: ControllerState): boolean {
  if (!state.environment) return true;
  const environment = instanceEnvironment(JSON.parse(decrypt(state.environment)));
  return INSTANCE_ENVIRONMENT_KEYS.every(
    (key) => (environment[key] ?? "") === (process.env[key] ?? ""),
  );
}

export async function setControllerRole(
  role: ControllerRole,
  handoffId: string | null,
  tx: DatabaseTransaction | typeof db = db,
  connection?: InstanceConnection | null,
): Promise<void> {
  await tx
    .update(schema.instanceController)
    .set({
      role,
      handoffId,
      revision: sql`${schema.instanceController.revision} + 1`,
      updatedAt: new Date(),
      ...(connection !== undefined
        ? { connection: connection ? encrypt(JSON.stringify(connection)) : null }
        : {}),
    })
    .where(eq(schema.instanceController.id, "local"));
}

export function controllerConnection(state: ControllerState): InstanceConnection | null {
  return state.connection ? (JSON.parse(decrypt(state.connection)) as InstanceConnection) : null;
}

let lifecycle: { start: () => Promise<void>; stop: () => Promise<void> } | undefined;
let lifecycleTail: Promise<void> = Promise.resolve();
function sequenceLifecycle(work: () => Promise<void>): Promise<void> {
  const next = lifecycleTail.then(work);
  lifecycleTail = next.catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "api/modules/system/instance/controller-state");
  });
  return next;
}
let restart: (() => void) | undefined;
const transports: Array<{ start(): Promise<void>; stop(): void | Promise<void> }> = [];
export function registerControllerTransport(value: (typeof transports)[number]): void {
  transports.push(value);
}
export function registerControllerRestart(value: () => void): void {
  restart = value;
}
export function restartController(): void {
  if (!restart) throw new Error("Restart this API to finish loading its transferred integrations.");
  restart();
}
export function registerControllerLifecycle(value: NonNullable<typeof lifecycle>): void {
  lifecycle = value;
}
export function startController(): Promise<void> {
  return sequenceLifecycle(async () => {
    if (!lifecycle) throw new Error("The controller is still starting. Try again shortly.");
    if (!(await controllerIsActive())) return;
    await lifecycle.start();
    for (const transport of transports) await transport.start();
  });
}
export function stopController(): Promise<void> {
  return sequenceLifecycle(async () => {
    if (!lifecycle) throw new Error("The controller is still starting. Try again shortly.");
    for (const transport of transports) await transport.stop();
    await lifecycle.stop();
  });
}

const requests = new Set<Promise<void>>();
export function trackControllerRequest(): () => void {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  requests.add(pending);
  return () => {
    requests.delete(pending);
    finish();
  };
}
export async function drainControllerRequests(): Promise<void> {
  while (requests.size) await Promise.all([...requests]);
}
