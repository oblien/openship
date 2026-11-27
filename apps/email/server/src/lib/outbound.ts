import { createHash, randomUUID } from 'node:crypto';
import addresses from 'email-addresses';
import Oblien from 'oblien';
import { z } from 'zod';
import { hostedSendingNamespace, permitsSendingNamespace, sendingSettings } from '../mail/sending-settings';
import { env } from '../env';
import { withImap, type ImapAuth } from './imap';
import { createRateLimiter } from './rate-limit';
import { sendMail, type SendInput, type SmtpAuth } from './smtp';

const mailboxLimit = createRateLimiter({ windowMs: 60_000, max: 30 });
const mailReceipt = z.object({
  id: z.string().min(1),
  state: z.enum(['queued', 'dispatching', 'unknown', 'accepted', 'delivered', 'delayed', 'failed', 'suppressed', 'bounced', 'complained']),
});

function address(value: string) {
  const parsed = addresses.parseOneAddress(value);
  if (parsed?.type !== 'mailbox') throw new Error('Invalid mailbox address.');
  return parsed.address;
}

/** Select the transport before submission. A provider timeout can follow
 * acceptance, so a failed API request must never trigger a second SMTP send. */
export function needsMime(input: SendInput, maxBodyLength = 500_000) {
  return !!(
    input.attachments?.length ||
    input.references?.length ||
    input.inReplyTo ||
    Object.keys(input.headers ?? {}).length ||
    !input.subject ||
    input.subject.length > 998 ||
    !(input.to.length || input.cc?.length || input.bcc?.length) ||
    (input.html?.length ?? 0) > maxBodyLength ||
    (input.text?.length ?? 0) > maxBodyLength ||
    (!input.html && !input.text) ||
    input.to.length + (input.cc?.length ?? 0) + (input.bcc?.length ?? 0) > 50
  );
}

export async function deliverMailboxMessage(smtp: SmtpAuth, imap: ImapAuth, input: SendInput) {
  const senderDomain = imap.user.toLowerCase().split('@')[1] ?? '';
  const hosted = hostedSendingNamespace();
  const settings = sendingSettings(senderDomain) ?? (hosted ? undefined : env.managedSending);
  if (!permitsSendingNamespace(hosted, settings?.namespace))
    throw new Error(
      'Verify and enable managed sending for this mailbox domain in the Emails dashboard.',
    );
  if (!settings) return sendMail(smtp, input);

  // A send-only domain key authorizes several addresses. Prove the individual
  // mailbox against this installation's trusted IMAP authority before using it.
  const from = address(input.from).toLowerCase();
  if (
    imap.host.toLowerCase() !== env.DEFAULT_IMAP_HOST?.toLowerCase() ||
    imap.port !== env.DEFAULT_IMAP_PORT ||
    from !== imap.user.toLowerCase() ||
    from !== smtp.user.toLowerCase()
  ) {
    throw new Error(
      'Managed sending requires the authenticated mailbox on the configured IMAP server.',
    );
  }
  if (!mailboxLimit.hit(from).ok)
    throw new Error('Mailbox sending limit reached. Try again in a minute.');
  const apiOrigin = 'apiOrigin' in settings ? settings.apiOrigin : undefined;
  if (needsMime(input, apiOrigin ? 250_000 : 500_000)) {
    if (hosted)
      throw new Error('The managed sending API supports text and HTML. This message requires full MIME delivery.');
    return sendMail(smtp, input);
  }

  await withImap(imap, async () => undefined);
  const messageId = input.messageId ?? `<${randomUUID()}@${from.split('@')[1]}>`;
  const idempotencyKey = createHash('sha256').update(messageId).digest('hex');
  const message = {
    from, to: input.to.map(address),
    cc: input.cc?.length ? input.cc.map(address) : undefined,
    bcc: input.bcc?.length ? input.bcc.map(address) : undefined,
    subject: input.subject, text: input.text || undefined, html: input.html || undefined,
  };
  let receipt;
  if (apiOrigin) {
    const response = await fetch(new URL('/api/mail/send', apiOrigin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { authorization: 'Bearer ' + settings.key, 'content-type': 'application/json' },
      body: JSON.stringify({ ...message, idempotencyKey }),
    });
    if (response.status !== 202) throw new Error(`OpenShip Mail API declined the submission (HTTP ${response.status}).`);
    const parsed = mailReceipt.safeParse(await response.json());
    if (!parsed.success) throw new Error('OpenShip Mail API returned an invalid receipt.');
    receipt = parsed.data;
  } else {
    if (!settings.namespace) throw new Error('Missing managed sending namespace.');
    const client = new Oblien({ token: settings.key });
    receipt = await client.mail.messages.send(settings.namespace, message, { idempotencyKey });
  }
  if (['failed', 'suppressed', 'bounced', 'complained'].includes(receipt.state))
    throw new Error('The sending provider rejected this message.');
  return { messageId };
}
