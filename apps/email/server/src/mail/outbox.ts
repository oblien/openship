import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, notInArray, lte, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { db, schema } from "../db";
import { encryptSecret, decryptSecret } from "../lib/crypto";
import { defaultUserSettings } from "../lib/schemas";
import { unsnoozeThreads, snoozeThreads, type SendMailInput } from "../lib/imap-driver";
import { mailboxAuth, mailboxCredentials, mailboxId, type MailboxCredentials } from "./identity";
import { liveGrant, purgeExpiredGrants } from "./grants";
import { mailRouteInternals } from "./messages";
import { blockRemoteContent, sanitizeMailHtml } from "../lib/sanitize";

type PreparedMessage = { from: string; message: SendMailInput };
type Job = typeof schema.mailJob.$inferSelect;
type Payload = PreparedMessage | { ids: string[] };
const context = (row: Pick<Job, "id" | "mailboxId">, purpose: string) =>
  `mail-job:${row.mailboxId}:${row.id}:${purpose}`;
const error = (message: string) => new TRPCError({ code: "CONFLICT", message });
const snoozeLocks = new Map<string, Promise<unknown>>();
async function withSnoozeLock<T>(owner: string, fn: () => Promise<T>): Promise<T> {
  const previous = snoozeLocks.get(owner) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(fn);
  snoozeLocks.set(owner, current);
  try {
    return await current;
  } finally {
    if (snoozeLocks.get(owner) === current) snoozeLocks.delete(owner);
  }
}

function clearSnoozes(tx: Pick<typeof db, "select" | "update">, owner: string, ids: string[]) {
  const rows = tx
    .select()
    .from(schema.mailJob)
    .where(
      and(
        eq(schema.mailJob.mailboxId, owner),
        eq(schema.mailJob.kind, "snooze"),
        inArray(schema.mailJob.state, ["pending", "running"]),
      ),
    )
    .all();
  for (const row of rows) {
    const payload = JSON.parse(decryptSecret(row.payload, context(row, "payload"))) as {
      ids: string[];
    };
    const remaining = payload.ids.filter((id) => !ids.includes(id));
    if (remaining.length === payload.ids.length) continue;
    tx.update(schema.mailJob)
      .set({
        state: remaining.length ? "pending" : "cancelled",
        credentials: remaining.length ? row.credentials : null,
        revision: row.revision + 1,
        payload: encryptSecret(JSON.stringify({ ids: remaining }), context(row, "payload")),
        updatedAt: Date.now(),
      })
      .where(eq(schema.mailJob.id, row.id))
      .run();
  }
}

export function scheduledTime(value?: string, delay = 0): number {
  const now = Date.now();
  if (!value) return now + delay;
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at < now + 1000 || at > now + 366 * 86_400_000) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Choose a future time within the next year.",
    });
  }
  return at;
}

function insertJob(
  mailbox: MailboxCredentials,
  kind: Job["kind"],
  payload: Payload,
  dueAt: () => number,
  options: { grantId?: string; requestId?: string } = {},
) {
  const owner = mailboxId(mailbox);
  const id = options.requestId
    ? createHash("sha256")
        .update(`${owner}:${options.grantId ?? "browser"}:${options.requestId}`)
        .digest("hex")
    : randomUUID();
  const key = { id, mailboxId: owner };
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded) > 25 * 1024 * 1024) {
    throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "Message exceeds 25 MB." });
  }
  return db.transaction((tx) => {
    const existing = tx.select().from(schema.mailJob).where(eq(schema.mailJob.id, id)).get();
    if (existing) {
      if (decryptSecret(existing.payload, context(existing, "payload")) !== encoded) {
        throw error("This request was already used for a different message.");
      }
      return existing;
    }
    const stored = tx
      .select({ bytes: sql<number>`coalesce(sum(length(${schema.mailJob.payload})), 0)` })
      .from(schema.mailJob)
      .where(eq(schema.mailJob.mailboxId, owner))
      .get()!;
    if (stored.bytes + Buffer.byteLength(encoded) > 50 * 1024 * 1024) {
      throw error(
        "The outbox storage limit is reached. Remove completed items before adding more.",
      );
    }
    const pending = tx
      .select({ count: sql<number>`count(*)` })
      .from(schema.mailJob)
      .where(
        and(
          eq(schema.mailJob.mailboxId, owner),
          inArray(schema.mailJob.state, ["pending", "approval", "running"]),
        ),
      )
      .get()!;
    if (pending.count >= 100) throw error("Review or cancel queued mail before adding more.");
    const due = dueAt();
    if (kind === "snooze" && "ids" in payload) clearSnoozes(tx, owner, payload.ids);
    return tx
      .insert(schema.mailJob)
      .values({
        ...key,
        kind,
        grantId: options.grantId,
        state: options.grantId ? "approval" : "pending",
        payload: encryptSecret(encoded, context(key, "payload")),
        credentials: encryptSecret(
          JSON.stringify(mailboxCredentials(mailbox)),
          context(key, "credentials"),
        ),
        dueAt: due,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .returning()
      .get();
  });
}

export function enqueueSend(
  mailbox: MailboxCredentials,
  message: PreparedMessage,
  scheduleAt?: string,
  options: { grantId?: string; requestId?: string } = {},
) {
  if (options.grantId && !liveGrant(options.grantId, mailboxId(mailbox), "mail:send")) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Sending is not permitted for this connection.",
    });
  }
  const prefs = db
    .select()
    .from(schema.userSettings)
    .where(eq(schema.userSettings.email, mailbox.email))
    .get()?.settings;
  const settings = { ...defaultUserSettings, ...prefs };
  const delay = settings.undoSendEnabled ? settings.undoSendTime * 1000 : 0;
  const job = insertJob(mailbox, "send", message, () => scheduledTime(scheduleAt, delay), options);
  return { messageId: job.id, sendAt: job.dueAt, state: job.state };
}

export function readJob(mailbox: MailboxCredentials, id: string) {
  const row = db
    .select()
    .from(schema.mailJob)
    .where(and(eq(schema.mailJob.mailboxId, mailboxId(mailbox)), eq(schema.mailJob.id, id)))
    .get();
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Scheduled item not found" });
  return row;
}

export function listJobs(mailbox: MailboxCredentials, offset = 0, view?: "upcoming" | "history") {
  const archivedStates: Job["state"][] = ["done", "cancelled"];
  const rows = db
    .select()
    .from(schema.mailJob)
    .where(
      and(
        eq(schema.mailJob.mailboxId, mailboxId(mailbox)),
        view === "history"
          ? inArray(schema.mailJob.state, archivedStates)
          : view === "upcoming"
            ? notInArray(schema.mailJob.state, archivedStates)
            : undefined,
      ),
    )
    .orderBy(
      ...(view === "upcoming"
        ? [asc(schema.mailJob.dueAt), asc(schema.mailJob.id)]
        : [
            desc(view === "history" ? schema.mailJob.updatedAt : schema.mailJob.createdAt),
            desc(schema.mailJob.id),
          ]),
    )
    .limit(21)
    .offset(offset)
    .all();
  return {
    hasMore: rows.length > 20,
    items: rows.slice(0, 20).map((row) => {
      const payload = JSON.parse(decryptSecret(row.payload, context(row, "payload"))) as Payload;
      return {
        id: row.id,
        revision: row.revision,
        kind: row.kind,
        state: row.state,
        dueAt: row.dueAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        error: row.error,
        grantId: row.grantId,
        subject: "message" in payload ? payload.message.subject : "Snoozed messages",
        to: "message" in payload ? payload.message.to : [],
      };
    }),
  };
}

export function jobDetails(mailbox: MailboxCredentials, id: string) {
  const row = readJob(mailbox, id);
  const payload = JSON.parse(decryptSecret(row.payload, context(row, "payload"))) as Payload;
  const previewHtml =
    "message" in payload && payload.message.html
      ? blockRemoteContent(sanitizeMailHtml(payload.message.html)).html
      : null;
  return { id, revision: row.revision, state: row.state, dueAt: row.dueAt, payload, previewHtml };
}

export function removeJob(mailbox: MailboxCredentials, id: string) {
  const row = readJob(mailbox, id);
  const removed = db
    .delete(schema.mailJob)
    .where(
      and(
        eq(schema.mailJob.id, row.id),
        inArray(schema.mailJob.state, ["done", "cancelled", "failed", "uncertain"]),
      ),
    )
    .returning()
    .get();
  if (!removed) throw error("Cancel this item before removing it.");
  return { ok: true };
}

export function cancelJob(mailbox: MailboxCredentials, id: string) {
  const row = readJob(mailbox, id);
  if (row.state === "cancelled") return { ok: true };
  if (row.kind !== "send") throw error("Use Unsnooze in your mailbox to wake these messages.");
  const updated = db
    .update(schema.mailJob)
    .set({
      state: "cancelled",
      credentials: null,
      revision: row.revision + 1,
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(schema.mailJob.id, row.id),
        inArray(schema.mailJob.state, ["pending", "approval"]),
        eq(schema.mailJob.revision, row.revision),
      ),
    )
    .returning()
    .get();
  if (!updated) throw error("Sending has already started. This message cannot be recalled.");
  return { ok: true };
}

/** Browser-only approval: the agent cannot invoke this operation or change its snapshot. */
export function approveJob(mailbox: MailboxCredentials, id: string, revision: number) {
  const row = readJob(mailbox, id);
  if (!row.grantId || !liveGrant(row.grantId, row.mailboxId, "mail:send")) {
    throw error("This agent connection expired or was revoked.");
  }
  const updated = db
    .update(schema.mailJob)
    .set({
      state: "pending",
      revision: revision + 1,
      dueAt: Math.max(Date.now() + 15_000, row.dueAt),
      updatedAt: Date.now(),
    })
    .where(
      and(
        eq(schema.mailJob.id, id),
        eq(schema.mailJob.state, "approval"),
        eq(schema.mailJob.revision, revision),
      ),
    )
    .returning()
    .get();
  if (!updated) throw error("This proposal changed. Review it again.");
  return { ok: true };
}

export function rescheduleJob(
  mailbox: MailboxCredentials,
  id: string,
  revision: number,
  at?: string,
) {
  const row = readJob(mailbox, id);
  if (row.grantId)
    throw error("Cancel this agent proposal and request a new one to change its schedule.");
  if (row.kind !== "send") throw error("Change the snooze time from your mailbox.");
  const updated = db
    .update(schema.mailJob)
    .set({ dueAt: scheduledTime(at), revision: revision + 1, updatedAt: Date.now() })
    .where(
      and(
        eq(schema.mailJob.id, row.id),
        eq(schema.mailJob.state, "pending"),
        eq(schema.mailJob.revision, revision),
      ),
    )
    .returning()
    .get();
  if (!updated) throw error("This item has changed or is already being processed.");
  return { ok: true };
}

export async function snooze(mailbox: MailboxCredentials, ids: string[], until: string) {
  return withSnoozeLock(mailboxId(mailbox), async () => {
    const job = insertJob(mailbox, "snooze", { ids }, () => scheduledTime(until));
    await snoozeThreads(mailboxAuth(mailbox).imap, { ids, until });
    return { ok: true, id: job.id };
  });
}

export async function unsnooze(mailbox: MailboxCredentials, ids: string[]) {
  return withSnoozeLock(mailboxId(mailbox), async () => {
    await unsnoozeThreads(mailboxAuth(mailbox).imap, { ids });
    db.transaction((tx) => clearSnoozes(tx, mailboxId(mailbox), ids));
    return { ok: true };
  });
}

export async function runOutboxPass(now = Date.now()) {
  purgeExpiredGrants();
  // Never resend after a crash or an ambiguous SMTP acknowledgement.
  db.update(schema.mailJob)
    .set({
      state: "uncertain",
      credentials: null,
      updatedAt: now,
      error: "Processing was interrupted. Check Sent before sending again.",
    })
    .where(
      and(
        eq(schema.mailJob.kind, "send"),
        eq(schema.mailJob.state, "running"),
        lte(schema.mailJob.updatedAt, now - 5 * 60_000),
      ),
    )
    .run();
  // Removing snooze flags is idempotent. Recover interrupted wake-ups, keeping
  // their credentials and fencing any old worker that eventually returns.
  db.update(schema.mailJob)
    .set({
      state: "pending",
      revision: sql`${schema.mailJob.revision} + 1`,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.mailJob.kind, "snooze"),
        eq(schema.mailJob.state, "running"),
        lte(schema.mailJob.updatedAt, now - 5 * 60_000),
      ),
    )
    .run();
  const candidates = db
    .select()
    .from(schema.mailJob)
    .where(and(eq(schema.mailJob.state, "pending"), lte(schema.mailJob.dueAt, now)))
    .orderBy(asc(schema.mailJob.dueAt))
    .limit(10)
    .all();
  for (const candidate of candidates) {
    const row = db
      .update(schema.mailJob)
      .set({ state: "running", updatedAt: now })
      .where(
        and(
          eq(schema.mailJob.id, candidate.id),
          eq(schema.mailJob.state, "pending"),
          eq(schema.mailJob.revision, candidate.revision),
        ),
      )
      .returning()
      .get();
    if (!row) continue;
    let state: Job["state"] = "done";
    let message: string | null = null;
    let dispatched = false;
    try {
      if (
        !row.credentials ||
        (row.grantId && !liveGrant(row.grantId, row.mailboxId, "mail:send"))
      ) {
        state = "cancelled";
      } else {
        const mailbox = JSON.parse(
          decryptSecret(row.credentials, context(row, "credentials")),
        ) as MailboxCredentials;
        if (mailboxId(mailbox) !== row.mailboxId) throw new Error("Mailbox mismatch");
        const auth = mailboxAuth(mailbox);
        const payload = JSON.parse(decryptSecret(row.payload, context(row, "payload"))) as Payload;
        if (row.kind === "send" && "message" in payload) {
          dispatched = true;
          await mailRouteInternals.send(auth.smtp, auth.imap, payload.from, {
            ...payload.message,
            messageId: `<${row.id}@${mailbox.email.split("@").at(-1)}>`,
          });
        } else if (row.kind === "snooze" && "ids" in payload) {
          dispatched = true;
          await withSnoozeLock(row.mailboxId, async () => {
            const current = db
              .select()
              .from(schema.mailJob)
              .where(eq(schema.mailJob.id, row.id))
              .get();
            if (current?.state === "running" && current.revision === row.revision)
              await unsnoozeThreads(auth.imap, payload);
          });
        } else throw new Error("Invalid job payload");
      }
    } catch {
      state = dispatched ? (row.kind === "send" ? "uncertain" : "pending") : "failed";
      message =
        state === "uncertain"
          ? "Delivery could not be confirmed. Check Sent or the recipient before sending again."
          : state === "pending"
            ? "Could not wake these messages. We will retry when the mailbox is available."
            : "Could not complete this item. Sign in again and retry from your mailbox.";
    }
    db.update(schema.mailJob)
      .set({
        state,
        error: message,
        credentials: state === "pending" ? row.credentials : null,
        dueAt: state === "pending" ? Math.max(now, Date.now()) + 60_000 : row.dueAt,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(schema.mailJob.id, row.id),
          eq(schema.mailJob.state, "running"),
          eq(schema.mailJob.revision, row.revision),
        ),
      )
      .run();
  }
  db.delete(schema.mailJob)
    .where(
      and(
        inArray(schema.mailJob.state, ["done", "cancelled"]),
        lte(schema.mailJob.updatedAt, now - 30 * 86_400_000),
      ),
    )
    .run();
}

export function startOutboxWorker() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runOutboxPass();
    } catch {
      console.error("[mail] Background mail processing failed; will check again.");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
