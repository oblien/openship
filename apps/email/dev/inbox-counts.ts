// Executed inside the isolated sample API container by the local dashboard worker.
import { withImap } from "../server/src/lib/imap";
import { mailboxAuth } from "../server/src/mail/identity";
import { sampleMailbox } from "./seed";

if (process.env.NODE_ENV !== "development" || process.env.SQLITE_PATH !== "/sample/mail.db" || process.env.DEFAULT_IMAP_HOST !== "mail") {
  throw new Error("Local sample inboxes are unavailable.");
}

const accounts = await Promise.all((["alex", "sam"] as const).map(async user => {
  const mailbox = sampleMailbox(user);
  const messages = await withImap(mailboxAuth(mailbox).imap, async client => {
    const status = await client.status("INBOX", { messages: true });
    return status && typeof status.messages === "number" ? status.messages : null;
  }, { timeoutMs: 5000 }).catch(() => null);
  return { username: mailbox.email, messages };
}));
console.log(JSON.stringify(accounts));
