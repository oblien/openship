import { Hono, type MiddlewareHandler } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db, schema } from '../db';
import { env } from '../env';
import {
  bindHostedSending,
  sharedHosting,
  hostedSendingNamespace,
  permitsSendingNamespace,
  configureSending,
  sendingAuthority,
} from '../mail/sending-settings';

const credentials = z
  .object({
    namespace: z.string().regex(/^openship-mail-[a-f0-9]{32}$/),
    keyId: z.string().min(1).max(64),
    key: z.string().min(1).max(4096).refine(value => !value.startsWith('opsh_')),
  })
  .strict();

const apiCredentials = z.object({
  namespace: credentials.shape.namespace.optional(),
  apiOrigin: z.url().refine(value => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.origin === value && (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  }),
  keyId: credentials.shape.keyId,
  key: z.string().max(4096).regex(/^opsh_(?:pat|send)_[A-Za-z0-9_-]+$/),
}).strict();

export const sendingAdminRoute = new Hono();
const authorize: MiddlewareHandler = async (c, next) => {
  const token = env.sendingAdminToken;
  const supplied = c.req.header('x-openship-sending-token');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!token || !supplied || !timingSafeEqual(digest(token), digest(supplied)))
    return c.json({ error: 'Unauthorized' }, 401);
  if (!env.DEFAULT_IMAP_HOST)
    return c.json({ error: 'Configure the trusted IMAP host first.' }, 409);
  if (c.req.param('domain') && !z.hostname().safeParse(c.req.param('domain')).success)
    return c.json({ error: 'Invalid sender domain' }, 400);
  c.header('Cache-Control', 'no-store');
  await next();
};
sendingAdminRoute.use('/sending/:domain', authorize);
sendingAdminRoute.put('/hosting', authorize, async (c) => {
  const input = z.union([
    z.object({ namespace: credentials.shape.namespace, imapHost: z.hostname(), dedicated: z.literal(true).optional() }).strict(),
    z.object({ shared: z.literal(true), imapHost: z.hostname() }).strict(),
  ])
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success || input.data.imapHost !== env.DEFAULT_IMAP_HOST?.toLowerCase())
    return c.json({ error: 'The linked webmail uses a different IMAP host.' }, 409);
  const binding = input.data;
  return c.json({ bound: 'shared' in binding
    ? bindHostedSending(sharedHosting)
    : bindHostedSending(binding.namespace, binding.dedicated) });
});
sendingAdminRoute.get('/sending/:domain', (c) => {
  const [row] = db
    .select({ namespace: schema.sendingDomain.namespace, keyId: schema.sendingDomain.keyId })
    .from(schema.sendingDomain)
    .where(eq(schema.sendingDomain.domain, c.req.param('domain').toLowerCase()))
    .all();
  return c.json({ sending: row ? { keyId: row.keyId, ...sendingAuthority(row.namespace) } : null });
});
sendingAdminRoute.put('/sending/:domain', async (c) => {
  const parsed = z.union([credentials, apiCredentials]).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid sending credentials' }, 400);
  const hosted = hostedSendingNamespace();
  const settings = parsed.data;
  if (!permitsSendingNamespace(hosted, settings.namespace))
    return c.json({ error: 'Invalid hosted namespace' }, 409);
  configureSending(
    c.req.param('domain').toLowerCase(),
    'apiOrigin' in settings
      ? settings.namespace ? JSON.stringify({ apiOrigin: settings.apiOrigin, namespace: settings.namespace }) : settings.apiOrigin
      : settings.namespace,
    settings.key,
    settings.keyId,
  );
  return c.json({ configured: true });
});
