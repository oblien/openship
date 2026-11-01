import { appLocale, type AppLocale } from "@repo/core";
import { repos, type ChatAppConnection } from "@repo/db";
import type { ChatSender } from "./chat-apps-common";

/** Linked senders use their own language; before linking, the bot uses its owner's preference. */
export async function chatLocale(c: ChatAppConnection, sender?: ChatSender): Promise<AppLocale> {
  const identity = sender
    ? await repos.chatApps.identity(c.id, sender.workspaceId, sender.userId)
    : undefined;
  return appLocale(await repos.settings.getLocale(identity?.userId ?? c.userId));
}
