import { z } from 'zod';

export const openshipApiOrigin = 'https://api.openship.io';
export const openshipSendingKey = z.string().max(4096).regex(/^opsh_(?:pat|send)_[A-Za-z0-9_-]+$/);

/** App settings on a standalone deployment. Hosted installations select a key per domain. */
export function appSendingSettings(key?: string, namespace?: string, imapHost?: string) {
  if (!key && !namespace) return undefined;
  if (!key || !imapHost) throw new Error('Managed sending requires a send-only key and a pinned IMAP host.');
  if (openshipSendingKey.safeParse(key).success) return { key, apiOrigin: openshipApiOrigin };
  if (key.startsWith('opsh_') || !namespace || namespace === 'openship')
    throw new Error('Set a valid OpenShip sending key or supply the namespace for your legacy sending key.');
  return { key, namespace };
}
