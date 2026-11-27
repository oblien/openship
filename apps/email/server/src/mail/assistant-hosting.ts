import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { SDK_VERSION } from "mindwire";
import { env } from "../env";
import type { MailboxIdentity } from "./identity";
import { mailHostingPlacement } from "./sending-settings";

export function mailboxAssistantPermitted(mailbox: MailboxIdentity, placement = mailHostingPlacement()) {
  return placement === "standalone" || (placement === "dedicated" &&
    mailbox.imapHost.toLowerCase() === env.DEFAULT_IMAP_HOST?.toLowerCase() &&
    mailbox.imapPort === env.DEFAULT_IMAP_PORT);
}

// Fleet activation stages the release for the SDK running in this webmail image.
export const dedicatedAssistantAsset = `mindwired-v${SDK_VERSION}-linux-${process.arch === "x64" ? "amd64" : process.arch}`;
export const dedicatedAssistantBinary = (socket: string) => join(dirname(socket), dedicatedAssistantAsset);

export function dedicatedAssistantSocket() {
  const path = env.MAIL_MINDWIRE_DOCKER_SOCKET ?? "/run/openship-mail-assistants/docker.sock";
  return statSync(path, { throwIfNoEntry: false })?.isSocket() &&
    statSync(dedicatedAssistantBinary(path), { throwIfNoEntry: false })?.isFile() ? path : undefined;
}
