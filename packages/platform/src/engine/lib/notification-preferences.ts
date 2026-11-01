import { repos, type NotificationChannel } from "@repo/db";
import { findCategory } from "./notification-categories";

/** Recheck security opt-outs just before delivery, including messages queued before the change. */
export async function notificationPreferenceAllows(
  userId: string,
  organizationId: string,
  category: string,
  channel: NotificationChannel,
): Promise<boolean> {
  const definition = findCategory(category);
  if (!definition?.defaultPerChannel) return true;
  const choices = await repos.notificationSubscription.listForUserInOrg(userId, organizationId);
  const choice = choices.find((row) => row.category === category && row.channelId === channel.id);
  if (choice) return choice.enabled;
  const defaults = await repos.notificationDefault.listByOrganization(organizationId);
  const configured = defaults.find((row) => row.category === category);
  return (
    (configured?.defaultEnabled ?? definition.defaultEnabled) &&
    (configured?.defaultChannelKinds ?? definition.defaultChannelKinds ?? ["email"]).includes(
      channel.kind,
    )
  );
}
