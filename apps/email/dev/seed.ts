import { access, writeFile } from "node:fs/promises";
import { withImap } from "../server/src/lib/imap";
import { composeRfc822 } from "../server/src/lib/smtp";
import { createDraft } from "../server/src/mail/drafts";
import { createGrant } from "../server/src/mail/grants";
import { enqueueSend } from "../server/src/mail/outbox";
import { mailboxAuth } from "../server/src/mail/identity";
import { env } from "../server/src/env";
import { updateBranding } from "../server/src/lib/branding";

export const sampleMailbox = (user: "alex" | "sam") => ({
  email: `${user}@openship.test`,
  name: user === "alex" ? "Alex Morgan" : "Sam Taylor",
  password: "sample-mail",
  imapHost: "mail",
  imapPort: 993,
  smtpHost: "mail",
  smtpPort: 465,
});

export async function seedSampleMail() {
  if (
    env.NODE_ENV !== "development" ||
    env.SQLITE_PATH !== "/sample/mail.db" ||
    env.DEFAULT_IMAP_HOST !== "mail" ||
    env.DEFAULT_SMTP_HOST !== "mail"
  ) {
    throw new Error("Sample seeding is restricted to the isolated dev Compose environment.");
  }
  const alex = sampleMailbox("alex");
  // GreenMail starts independently. Retry connection setup before creating sample data.
  const deadline = Date.now() + 45_000;
  while (true) {
    try {
      await withImap(mailboxAuth(alex).imap, async () => {});
      break;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await Bun.sleep(500);
    }
  }
  for (const user of ["alex", "sam"] as const) {
    const mailbox = sampleMailbox(user);
    const fresh = await withImap(mailboxAuth(mailbox).imap, async (client) => {
      const folders = new Set((await client.list()).map((folder) => folder.path));
      for (const folder of ["Sent", "Drafts", "Trash", "Junk", "Archive"]) {
        if (!folders.has(folder)) await client.mailboxCreate(folder);
      }
      const lock = await client.getMailboxLock("INBOX");
      try {
        const seeded = await client.search(
          { header: { "Message-ID": `<welcome-${user}@sample.openship.test>` } },
          { uid: true },
        );
        if (seeded && seeded.length) return false;
        const samples = [
          {
            id: `welcome-${user}`,
            from: "OpenShip Mail <hello@openship.test>",
            subject: "Your sample inbox is ready",
            body: `<h2>Welcome, ${mailbox.name.split(" ")[0]}</h2><p>This is a real IMAP inbox. Try replying, attaching a file, saving a draft, snoozing, or scheduling a message.</p><p>Sign in to the second account to see your deliveries. All mail stays in the local test server.</p>`,
          },
          {
            id: `launch-${user}`,
            from: "Sam Taylor <sam@openship.test>",
            subject: "Launch checklist — ready for review?",
            body: "<p>Hi Alex,</p><p>Could you review the release notes before Friday? The inbox, scheduling, and attachment flows are ready.</p><p>Sam</p>",
            attachment: true,
          },
          {
            id: `design-${user}`,
            from: "Maya Chen <maya@openship.test>",
            subject: "A quieter inbox design",
            body: "<p>The updated navigation is ready. I kept the actions compact and moved secondary controls into the menu.</p><p>Let me know what you think.</p>",
            starred: true,
          },
          {
            id: `invoice-${user}`,
            from: "Billing <billing@openship.test>",
            subject: "Invoice #1042 — sample document",
            body: "<p>Your sample invoice is attached. This is test data; there is no payment to make.</p>",
            attachment: true,
            seen: true,
          },
          {
            id: `meeting-${user}`,
            from: "Sam Taylor <sam@openship.test>",
            subject: "Tomorrow’s planning session",
            body: "<p>Can we meet at 10:30 tomorrow? Please bring your notes on the launch.</p>",
          },
          {
            id: `update-${user}`,
            from: "Product updates <updates@openship.test>",
            subject: "What’s new this week",
            body: "<p>Send later, a global mail assistant, and scoped agent access are ready to try.</p>",
            seen: true,
          },
        ];
        for (const [index, sample] of samples.entries()) {
          const mime = await composeRfc822({
            from: sample.from,
            to: [mailbox.email],
            subject: sample.subject,
            html: sample.body,
            messageId: `<${sample.id}@sample.openship.test>`,
            attachments: sample.attachment
              ? [
                  {
                    filename: "sample-notes.txt",
                    content: "Sample document\nNo real customer data.\n",
                  },
                ]
              : undefined,
          });
          const flags = [
            ...(sample.seen ? ["\\Seen"] : []),
            ...(sample.starred ? ["\\Flagged"] : []),
          ];
          await client.append("INBOX", mime, flags, new Date(Date.now() - index * 3_600_000));
        }
        return true;
      } finally {
        lock.release();
      }
    });
    if (fresh)
      await createDraft(mailbox, {
        id: `<sample-draft-${user}@sample.openship.test>`,
        to: user === "alex" ? "sam@openship.test" : "alex@openship.test",
        subject: "A draft to finish",
        message:
          "<p>Hi! This draft is stored in the real Drafts folder. Add a line and send it.</p>",
      });
  }
  const marker = "/sample/seeded";
  if (
    !(await access(marker).then(
      () => true,
      () => false,
    ))
  ) {
    updateBranding({
      siteTitle: "OpenShip Mail · Sample",
      loginSubtext: "alex@openship.test or sam@openship.test · Password: sample-mail",
      loginFooter: "Local sample mail. Messages stay inside this test environment.",
    });
    const grant = createGrant(alex, {
      name: "Sample agent",
      scopes: ["mail:read", "mail:draft", "mail:send"],
      expiresInDays: 30,
    });
    enqueueSend(
      alex,
      {
        from: alex.email,
        message: {
          to: ["sam@openship.test"],
          subject: "Review this sample send proposal",
          html: "<p>Hi Sam, the mail test environment is ready. This message sends only after Alex approves it in Scheduled.</p>",
        },
      },
      undefined,
      { grantId: grant.id, requestId: "b16c63d6-d8b0-4b3c-ae64-d8ea02b68844" },
    );
    await writeFile(marker, "Sample approval created.\n");
  }
  console.log("[sample mail] Two mailboxes seeded. Password: sample-mail");
}
