import { z } from "zod";
import { TRPCError } from "@trpc/server";
import addresses from "email-addresses";
import { getThread, send as driverSend, normalizeFolderSlug } from "../lib/imap-driver";
import { mailboxAuth, type MailboxCredentials } from "./identity";

// Recipients arrive from the client as `{email, name}` objects (Sender).
// We accept either that or a bare email string for backward compat.
export const mailHeader = z
  .string()
  .max(998)
  .refine((value) => !/[\r\n\0]/.test(value), "Invalid mail header");
const header = mailHeader;
export const mailAttachment = z.object({
  name: z.string().max(255),
  type: z.string().max(127),
  base64: z
    .string()
    .max(25 * 1024 * 1024)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
const address = header.refine(
  (value) => addresses.parseOneAddress(value)?.type === "mailbox",
  "Invalid email address",
);
const senderInput = z.union([address, z.object({ email: z.email(), name: header.optional() })]);
type SenderInput = z.infer<typeof senderInput>;
function senderToAddress(s: SenderInput): string {
  if (typeof s === "string") return s;
  return s.name ? `${JSON.stringify(s.name)} <${s.email}>` : s.email;
}

export function formatFromAddress(
  fromEmail: string | undefined,
  sessionEmail: string,
  sessionName: string | null | undefined,
): string {
  const raw = fromEmail || sessionEmail;
  if (raw.includes("<")) return raw;
  const name = sessionName?.replace(/[<>"\r\n\0]/g, "").trim();
  return name ? `"${name}" <${raw.trim()}>` : raw;
}

/** Injectable seam for route-level tests; production uses the real IMAP/SMTP drivers. */
export const mailRouteInternals = {
  getThread,
  send: driverSend,
};

const folderInput = z.string().optional();
export const sendInput = z
  .object({
    to: z.array(senderInput).max(100),
    cc: z.array(senderInput).max(100).optional(),
    bcc: z.array(senderInput).max(100).optional(),
    subject: header,
    message: z.string().max(256_000).optional(),
    text: z.string().max(256_000).optional(),
    html: z.string().max(256_000).optional(),
    body: z.string().max(256_000).optional(),
    attachments: z.array(mailAttachment).max(100).optional(),
    fromEmail: address.optional(),
    draftId: z.string().optional(),
    threadId: z.string().nullable().optional(),
    isForward: z.boolean().optional(),
    originalMessage: z.string().optional(),
    originalMessageId: z.string().optional(),
    originalFolder: folderInput,
    scheduleAt: z.iso.datetime({ offset: true }).optional(),
    requestId: z.uuid().optional(),
    headers: z.record(header, header).optional(),
    inReplyTo: header.optional(),
    references: z.array(header).max(100).optional(),
  })
  .refine(
    (input) => input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) > 0,
    "At least one recipient is required",
  );

export async function prepareMessage(
  mailbox: MailboxCredentials,
  input: z.infer<typeof sendInput>,
) {
  requireMailboxSender(input.fromEmail, mailbox.email);
  const refsHeader = input.headers?.References;
  const inReplyToHeader = input.headers?.["In-Reply-To"];
  const fromAddress = formatFromAddress(input.fromEmail, mailbox.email, mailbox.name);

  let originalHtml = input.originalMessage;
  let forwardedAttachments: typeof input.attachments;
  if (input.isForward && input.originalMessageId) {
    const original = await mailRouteInternals.getThread(
      mailboxAuth(mailbox).imap,
      input.originalMessageId,
      normalizeFolderSlug(input.originalFolder),
      undefined,
      { includeAttachmentBytes: true },
    );
    if (!original?.latest) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Original message could not be loaded for forwarding",
      });
    }
    originalHtml = original.latest.decodedBody ?? originalHtml;
    forwardedAttachments = original.latest.attachments.map((attachment) => ({
      name: attachment.filename,
      type: attachment.contentType,
      base64: attachment.body,
    }));
  }

  const outgoingHtml = input.isForward
    ? `${input.message ?? input.html ?? input.body ?? ""}${originalHtml ?? ""}`
    : originalHtml && (input.inReplyTo || inReplyToHeader)
      ? `${input.message ?? input.html ?? input.body ?? ""}<blockquote>${originalHtml}</blockquote>`
      : (input.message ?? input.html ?? input.body ?? undefined);
  const attachments =
    forwardedAttachments?.length || input.attachments?.length
      ? [...(forwardedAttachments ?? []), ...(input.attachments ?? [])]
      : undefined;

  return {
    from: fromAddress,
    message: {
      to: input.to.map(senderToAddress),
      cc: input.cc?.map(senderToAddress),
      bcc: input.bcc?.map(senderToAddress),
      subject: input.subject,
      html: outgoingHtml,
      text: input.text,
      attachments,
      inReplyTo: input.inReplyTo ?? inReplyToHeader ?? undefined,
      references:
        input.references ?? (refsHeader ? refsHeader.split(/\s+/).filter(Boolean) : undefined),
    },
  };
}

export function requireMailboxSender(from: string | null | undefined, mailbox: string) {
  const parsed = addresses.parseOneAddress(from || mailbox);
  if (
    !parsed ||
    parsed.type !== "mailbox" ||
    parsed.address.toLowerCase() !== mailbox.toLowerCase()
  ) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Send from your signed-in mailbox." });
  }
}
