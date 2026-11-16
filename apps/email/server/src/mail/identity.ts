import { createHash, randomUUID } from "node:crypto";
import { db, schema } from "../db";
import type { SessionContext } from "../lib/session";

export type MailboxIdentity = Pick<
  SessionContext,
  "email" | "imapHost" | "imapPort" | "smtpHost" | "smtpPort"
>;
export type MailboxCredentials = MailboxIdentity & Pick<SessionContext, "password" | "name">;

// A restored database keeps its namespace; independent installations don't share it.
db.insert(schema.mailInstance)
  .values({ id: "instance", value: randomUUID() })
  .onConflictDoNothing()
  .run();
const instanceId = db.select().from(schema.mailInstance).get()!.value;

export function mailboxId(mailbox: MailboxIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        instanceId,
        mailbox.email.toLowerCase(),
        mailbox.imapHost.toLowerCase(),
        mailbox.imapPort,
        mailbox.smtpHost.toLowerCase(),
        mailbox.smtpPort,
      ]),
    )
    .digest("hex");
}

export function mailboxCredentials(session: MailboxCredentials): MailboxCredentials {
  const { email, name, password, imapHost, imapPort, smtpHost, smtpPort } = session;
  return { email, name, password, imapHost, imapPort, smtpHost, smtpPort };
}

export function mailboxAuth(mailbox: MailboxCredentials) {
  return {
    imap: {
      host: mailbox.imapHost,
      port: mailbox.imapPort,
      user: mailbox.email,
      pass: mailbox.password,
    },
    smtp: {
      host: mailbox.smtpHost,
      port: mailbox.smtpPort,
      user: mailbox.email,
      pass: mailbox.password,
    },
  };
}
