/**
 * WHO relays — the sender-selection half of the outbound relay.
 *
 * A relay is either global ("everything leaves via the provider") or scoped to
 * chosen envelope senders: whole domains (`@example.com`) and/or individual
 * addresses (`contact@example.com`). The address case is the one that needs these
 * helpers to be shared: a mailbox can RECEIVE here (IMAP) while only its SENDING
 * goes through the operator's provider, so what counts as a valid sender, how it's
 * case-folded into a Postfix map key, and which domains then have to advertise the
 * provider in SPF must be answered the SAME way in the dashboard (which gates the
 * Save button) and in the API (which writes the map rows). Two copies of that
 * answer is a form that accepts input the server rejects.
 *
 * Pure, no I/O. Postfix/SQL specifics stay in the API service.
 */

/**
 * A single envelope sender: exactly one `@`, a DNS-shaped domain, and a localpart
 * with no whitespace or SQL/map metacharacters. These become `sender_relayhost`
 * keys, so a bare mailbox is all we accept — no display name, no angle brackets.
 */
export const SENDER_ADDRESS_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}$/;

/** `contact@Example.COM ` → `contact@example.com`. Map keys are case-folded. */
export function normalizeSenderAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Is this something we can use as a relay sender key? */
export function isSenderAddress(raw: string): boolean {
  return SENDER_ADDRESS_RE.test(normalizeSenderAddress(raw));
}

export interface RelaySenderSelection {
  /** Whole domains that relay (every sender in them). */
  domains?: string[];
  /** Individual addresses that relay, without their domain opting in. */
  addresses?: string[];
}

/**
 * The `sender_relayhost` keys for a scoped relay, in the order Postfix's map
 * resolves them: an address row is more specific than its `@domain` row and the
 * map query takes the first hit, so both can coexist.
 */
export function relaySenderKeys(sel: RelaySenderSelection): string[] {
  const keys = new Set<string>();
  for (const a of sel.addresses ?? []) keys.add(normalizeSenderAddress(a));
  for (const d of sel.domains ?? []) keys.add(`@${d.trim().toLowerCase()}`);
  return [...keys];
}

/**
 * Every domain whose DNS must advertise the relay send-hop: the selected domains
 * plus the domain of every selected address. Relaying `contact@example.com` still
 * needs `example.com`'s SPF to authorize the provider — SPF is published per
 * domain, so one relayed address is enough to need the include.
 */
export function relayedDomainsFor(sel: RelaySenderSelection): string[] {
  const out = new Set<string>();
  for (const d of sel.domains ?? []) out.add(d.trim().toLowerCase());
  for (const a of sel.addresses ?? []) {
    const addr = normalizeSenderAddress(a);
    const at = addr.lastIndexOf("@");
    if (at > 0) out.add(addr.slice(at + 1));
  }
  return [...out];
}

/** Is anything actually selected? A scoped relay with nothing chosen is a no-op. */
export function hasRelaySelection(sel: RelaySenderSelection): boolean {
  return relaySenderKeys(sel).length > 0;
}

/** Implicit-TLS submission (SMTPS). Postfix has no per-destination form for it. */
export const IMPLICIT_TLS_PORT = 465;

/**
 * Can't relay only SOME senders over :465. Implicit TLS is the global client
 * setting `smtp_tls_wrappermode`, so turning it on for the relay makes Postfix
 * speak TLS-on-connect to every direct MX on port 25 too — killing delivery for
 * every domain that did not opt in. Every provider we offer also listens on a
 * STARTTLS submission port (587), which scopes cleanly.
 */
export function implicitTlsUnsupported(input: { scope?: string; port: number }): boolean {
  return input.scope === "selected" && input.port === IMPLICIT_TLS_PORT;
}
