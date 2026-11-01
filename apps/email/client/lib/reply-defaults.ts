type Address = { email: string };

type ReplyMessage = {
  sender: Address;
  to?: Address[];
  cc?: Address[];
  subject?: string | null;
};

export type ReplyMode = "reply" | "replyAll" | "forward";

export function getReplyDefaults(message: ReplyMessage, mode: ReplyMode, ownEmails: string[]) {
  const ownAddresses = new Set(ownEmails.map((email) => email.toLowerCase()));
  const uniqueExternal = (addresses: string[]) =>
    addresses.filter(
      (email, index, all) =>
        !ownAddresses.has(email.toLowerCase()) &&
        all.findIndex((candidate) => candidate.toLowerCase() === email.toLowerCase()) === index,
    );
  const originalSubject = message.subject?.trim() || "";
  const prefix = mode === "forward" ? "Fwd:" : "Re:";
  const subject = new RegExp(`^${prefix}`, "i").test(originalSubject)
    ? originalSubject
    : `${prefix} ${originalSubject}`.trim();

  if (mode === "forward") return { to: [], cc: [], subject };

  const sender = message.sender.email;
  const fallbackRecipient = message.to?.find(
    (recipient) => !ownAddresses.has(recipient.email.toLowerCase()),
  )?.email;
  const to = uniqueExternal(
    [
      ownAddresses.has(sender.toLowerCase()) ? (fallbackRecipient ?? "") : sender,
      ...(mode === "replyAll" ? (message.to ?? []).map((recipient) => recipient.email) : []),
    ].filter(Boolean),
  );
  const cc =
    mode === "replyAll"
      ? uniqueExternal((message.cc ?? []).map((recipient) => recipient.email)).filter(
          (email) => !to.some((toEmail) => toEmail.toLowerCase() === email.toLowerCase()),
        )
      : [];

  return { to, cc, subject };
}
