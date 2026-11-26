import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { encryptSecret, decryptSecret } from '../lib/crypto';

// The existing column and encryption context identify the key issuer: a provider
// namespace on older installations, or the linked OpenShip API's origin.
export function sendingAuthority(issuer: string) {
  if (issuer.startsWith('{')) {
    const { apiOrigin, namespace } = JSON.parse(issuer) as { apiOrigin: string; namespace: string };
    return { apiOrigin, namespace };
  }
  return issuer.includes('://') ? { apiOrigin: issuer } : { namespace: issuer };
}

export function sendingSettings(domain: string) {
  const saved = db
    .select()
    .from(schema.sendingDomain)
    .where(eq(schema.sendingDomain.domain, domain))
    .get();
  return (
    saved && {
      ...sendingAuthority(saved.namespace),
      key: decryptSecret(saved.secret, saved.namespace + '/' + domain),
    }
  );
}

export function configureSending(domain: string, namespace: string, key: string, keyId: string) {
  const values = { domain, namespace, keyId, secret: encryptSecret(key, namespace + '/' + domain) };
  db.insert(schema.sendingDomain)
    .values(values)
    .onConflictDoUpdate({ target: schema.sendingDomain.domain, set: values })
    .run();
}

const hostingId = 'hosted-sending-namespace';
const dedicatedId = 'dedicated-mail-namespace';

export function hostedSendingNamespace() {
  return db.select().from(schema.mailInstance).where(eq(schema.mailInstance.id, hostingId)).get()
    ?.value;
}

// Existing installations store their exclusive namespace under this key.
export const sharedHosting = 'shared';

export function mailHostingPlacement() {
  const records = db.select().from(schema.mailInstance)
    .where(inArray(schema.mailInstance.id, [hostingId, dedicatedId])).all();
  const namespace = records.find(row => row.id === hostingId)?.value;
  if (!namespace) return 'standalone';
  return namespace !== sharedHosting && records.some(row => row.id === dedicatedId && row.value === namespace)
    ? 'dedicated' : 'standard';
}

export function bindHostedSending(namespace: string, dedicated = false) {
  return db.transaction(tx => {
    tx.insert(schema.mailInstance).values({ id: hostingId, value: namespace }).onConflictDoNothing().run();
    if (tx.select().from(schema.mailInstance).where(eq(schema.mailInstance.id, hostingId)).get()?.value !== namespace)
      return false;
    if (dedicated && namespace !== sharedHosting) {
      tx.insert(schema.mailInstance).values({ id: dedicatedId, value: namespace })
        .onConflictDoUpdate({ target: schema.mailInstance.id, set: { value: namespace } }).run();
    } else {
      tx.delete(schema.mailInstance).where(eq(schema.mailInstance.id, dedicatedId)).run();
    }
    return true;
  });
}
