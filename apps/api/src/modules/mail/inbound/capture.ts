/**
 * Arming and disarming inbound capture on the mail engine.
 *
 * The whole mechanism is one row in `vmail.recipient_bcc_domain`, a table the shipped
 * `main.cf` already consults on every message via `proxy:pgsql`. So arming needs no
 * postmap, no reload, no container recreate, and behaves identically on the container and
 * legacy host flavors — which is what lets this ship to mail boxes that already exist.
 *
 * DOMAIN-KEYED, ALWAYS. `recipient_bcc_user` is PRIMARY KEY (username) and
 * `recipient_bcc_domain` is PRIMARY KEY (domain) — one slot each — and Postfix consults
 * the USER table first, so a mailbox-scope row would MASK the domain-scope row for that
 * mailbox and make a domain rule silently skip it. Everything is armed at the domain
 * level; mailbox/sender/subject scoping happens in the control plane (see filter.ts).
 *
 * NO MIRROR TABLE. What is armed is read back from vmail rather than cached: the token
 * lives inside the `bcc_address` itself, and the collector's maildir lives in
 * `vmail.mailbox`. A cache of the engine's own state is a thing that goes stale.
 *
 * NOT ATOMIC, and it cannot be: provisioning spans the engine's `vmail` DB and its disk,
 * over SSH, with no transaction available across them. `mailboxes.service.ts` hits the
 * same wall and compensates the same way — a transaction for the two SQL rows, then the
 * disk step, then a rollback of the rows if the disk step fails. The orphan that matters
 * is the reverse (a BCC row armed with no reachable collector, quietly copying a domain's
 * mail into a folder nobody reads), which is why `reconcile` exists below.
 */

// `shellQuote` from core rather than a local copy: the mail module already carries five
// byte-identical private ones, and core's docstring records that nine existed before it
// was consolidated. Every value interpolated into a command on this path reaches root on a
// host-networked, NET_ADMIN container, so it should be the audited one.
import { safeErrorMessage } from "@repo/core";
import { execute, q, queryOne, transaction } from "../admin/psql-runner";
import { hashPassword } from "../admin/password";
import { createMaildirOnDisk, generateMaildir, STORAGE_BASE, STORAGE_NODE } from "../admin/maildir";
import {
  buildUpsertMailboxSql,
  buildUpsertSelfForwardingSql,
  randomPassword,
} from "../admin/platform-mailbox.service";
import { mailEngineCommand, runMailCommand, type MailTarget } from "../mail-engine";

/** The local part every collector mailbox uses. One per domain. */
export const COLLECTOR_LOCAL_PART = "openship-hook";

/**
 * How a token is recognised as OURS in the single BCC slot.
 *
 * Anything else in that slot belongs to the operator (archiving, compliance BCC,
 * iRedAdmin-Pro) and must never be overwritten — see {@link armDomain}.
 */
const COLLECTOR_PREFIX = `${COLLECTOR_LOCAL_PART}+`;

/**
 * Tokens are `[a-z0-9]` only, and that is a correctness requirement rather than style:
 * the Dovecot LDA pipe runs with `flags=DRh`, whose `h` folds the DOMAIN to lowercase but
 * NOT the extension, while the userdb query LOWER()s the whole home path. A mixed-case
 * token would name a folder that the path we compute cannot find.
 *
 * It is also a bearer secret. `openship-hook+<token>@<domain>` is a real, externally
 * addressable mailbox on the public MX and nothing in the shipped config restricts who
 * may send to it, so anyone who learns a token can post into the collector and fire
 * notifications. 24 chars of base32-ish alphabet is ~120 bits.
 */
export function generateToken(): string {
  return randomPassword(32).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
}

export function collectorAddress(domain: string, token: string): string {
  return `${COLLECTOR_PREFIX}${token}@${domain.toLowerCase()}`;
}

export function collectorMailbox(domain: string): string {
  return `${COLLECTOR_LOCAL_PART}@${domain.toLowerCase()}`;
}

/** What the engine currently says about one domain's capture. */
export interface ArmedState {
  domain: string;
  /** The raw value in the BCC slot, or null when the slot is empty. */
  bccAddress: string | null;
  /** Our token, when the slot holds one of ours. */
  token: string | null;
  /** True when the slot holds a value that is NOT ours — we must not touch it. */
  foreign: boolean;
  /** Absolute maildir of the collector mailbox, when it exists. */
  maildirPath: string | null;
}

/** Parse our token out of a bcc_address, or null when it is not ours. */
export function tokenFromBcc(bccAddress: string | null | undefined): string | null {
  if (!bccAddress) return null;
  const local = bccAddress.split("@")[0] ?? "";
  if (!local.startsWith(COLLECTOR_PREFIX)) return null;
  const token = local.slice(COLLECTOR_PREFIX.length);
  return /^[a-z0-9]+$/.test(token) ? token : null;
}

/**
 * Read what is armed for a domain, straight from the engine. This is the source of truth
 * — there is no local mirror to consult.
 *
 * The maildir is SELECTed, never recomputed: `generateMaildir` embeds a UTC creation
 * timestamp, so a rebuilt path points at a directory that does not exist.
 */
export async function readArmedState(target: MailTarget, domain: string): Promise<ArmedState> {
  const d = domain.toLowerCase();
  const bcc = await queryOne<{ bcc_address: string }>(
    target,
    `SELECT bcc_address FROM recipient_bcc_domain WHERE domain = ${q(d)} AND active = 1`,
  );
  const box = await queryOne<{ base: string; node: string; maildir: string }>(
    target,
    `SELECT storagebasedirectory AS base, storagenode AS node, maildir
       FROM mailbox WHERE username = ${q(collectorMailbox(d))}`,
  );
  const token = tokenFromBcc(bcc?.bcc_address);
  return {
    domain: d,
    bccAddress: bcc?.bcc_address ?? null,
    token,
    foreign: Boolean(bcc?.bcc_address) && token === null,
    maildirPath: box ? `${box.base}/${box.node}/${box.maildir}` : null,
  };
}

/** Raised when the operator's own BCC occupies the slot. Never clobbered. */
export class ForeignBccError extends Error {
  constructor(
    readonly domain: string,
    readonly bccAddress: string,
  ) {
    super(
      `${domain} already has a recipient BCC set to ${bccAddress}. Postfix allows only ` +
        `one per domain, so arming inbound capture would silently disable it. Remove or ` +
        `move that BCC first.`,
    );
    this.name = "ForeignBccError";
  }
}

/**
 * Make sure the collector mailbox for a domain exists.
 *
 * Three artifacts have to line up, exactly as `mailboxes.service.ts` documents: the
 * `vmail.mailbox` auth row, a SELF-FORWARDING row in `vmail.forwardings` (without which
 * Postfix REJECTS the address even though the mailbox exists — and a domain catch-all
 * cannot rescue it, because `catchall_maps.cf` explicitly excludes keys containing `+`),
 * and the on-disk maildir.
 *
 * QUOTA 0 (unlimited) is not laziness. Over-quota is `552 5.2.2` — a PERMANENT 5xx — and
 * because the BCC recipient is added in `cleanup(8)` AFTER smtpd, Dovecot's quota-status
 * policy cannot reject it at RCPT time. It becomes a delivery-time bounce whose envelope
 * sender is the ORIGINAL third party, so a full collector would mail confusing bounces to
 * strangers who wrote to your users. `quota_full_tempfail` is set nowhere in the tree, so
 * there is no defer to fall back on. The read job deletes every message it dispatches,
 * which is what keeps unlimited safe.
 *
 * Idempotent: upserts, so a re-arm converges instead of failing.
 */
export async function ensureCollectorMailbox(
  target: MailTarget,
  domain: string,
): Promise<{ username: string; maildirPath: string }> {
  const d = domain.toLowerCase();
  const username = collectorMailbox(d);

  const existing = await queryOne<{ base: string; node: string; maildir: string }>(
    target,
    `SELECT storagebasedirectory AS base, storagenode AS node, maildir
       FROM mailbox WHERE username = ${q(username)}`,
  );
  if (existing) {
    return { username, maildirPath: `${existing.base}/${existing.node}/${existing.maildir}` };
  }

  // Never returned to anyone. The collector is not an interactive account: nothing signs
  // in as it, and the control plane reads its maildir over the exec channel instead.
  const hash = await hashPassword(target, randomPassword(40));
  const layout = generateMaildir(d, COLLECTOR_LOCAL_PART);

  await transaction(target, [
    buildUpsertMailboxSql({
      username,
      passwordHash: hash,
      name: "Openship inbound capture",
      domain: d,
      storagebasedirectory: layout.storagebasedirectory,
      storagenode: layout.storagenode,
      maildir: layout.maildir,
      quotaMB: 0,
    }),
    buildUpsertSelfForwardingSql(username, d),
  ]);

  try {
    await createMaildirOnDisk(target, layout);
  } catch (err) {
    // Same compensating rollback as createMailbox: leaving the rows behind would make
    // Postfix accept mail for an address whose storage does not exist, which bounces.
    await execute(target, `DELETE FROM forwardings WHERE address = ${q(username)}`).catch(() => {});
    await execute(target, `DELETE FROM mailbox WHERE username = ${q(username)}`).catch(() => {});
    throw new Error(
      `Could not create the collector maildir for ${d}: ${safeErrorMessage(err)}`,
    );
  }

  return {
    username,
    maildirPath: `${STORAGE_BASE}/${STORAGE_NODE}/${layout.maildir}`,
  };
}

/**
 * Arm capture for one domain, returning the token in the slot.
 *
 * Refuses rather than overwrites when the slot holds somebody else's BCC: that single row
 * is shared with operator archiving and compliance copies, and taking it would silently
 * turn those off.
 *
 * Re-arming an already-armed domain KEEPS the existing token. Rotating it would orphan
 * whatever is already sitting in the folder that token names.
 */
export async function armDomain(target: MailTarget, domain: string): Promise<string> {
  const d = domain.toLowerCase();
  const state = await readArmedState(target, d);
  if (state.foreign) throw new ForeignBccError(d, state.bccAddress!);

  await ensureCollectorMailbox(target, d);

  if (state.token) return state.token;

  const token = generateToken();
  await execute(
    target,
    `INSERT INTO recipient_bcc_domain (domain, bcc_address, active)
       VALUES (${q(d)}, ${q(collectorAddress(d, token))}, 1)
     ON CONFLICT (domain) DO UPDATE SET
       bcc_address = EXCLUDED.bcc_address, active = 1, modified = NOW()`,
  );
  return token;
}

/**
 * Disarm a domain: drop the BCC row so Postfix stops copying immediately.
 *
 * The collector mailbox and anything still in it are LEFT ALONE. Deleting a mailbox is
 * destructive and this is called from a rule delete, which the operator may well be
 * undoing a moment later. Only our own row is removed — a foreign BCC is left untouched.
 */
export async function disarmDomain(target: MailTarget, domain: string): Promise<void> {
  const d = domain.toLowerCase();
  const state = await readArmedState(target, d);
  if (!state.token) return;
  await execute(
    target,
    `DELETE FROM recipient_bcc_domain
       WHERE domain = ${q(d)} AND bcc_address LIKE ${q(`${COLLECTOR_PREFIX}%`)}`,
  );
}

/**
 * The domain a rule's target names — the one place that parses `scope` + `target`.
 *
 * Null for `scope: "all"`, which names no single domain and is resolved differently by
 * each caller (the write path asks the engine for every domain; the read path asks which
 * domains are actually armed). Everything else about the derivation is identical, and it
 * lived twice — once in the controller and once in the read job — which is exactly how the
 * two drift on a mailbox address that contains an unexpected character.
 */
export function ruleDomain(rule: {
  scope: string;
  target: string | null;
}): string | null {
  const t = rule.target?.trim().toLowerCase();
  if (!t) return null;
  if (rule.scope === "domain") return t;
  if (rule.scope === "mailbox") {
    const at = t.indexOf("@");
    return at > 0 ? t.slice(at + 1) : null;
  }
  return null;
}

/** Every domain on the engine — what `scope: "all"` fans out over. */
export async function listEngineDomains(target: MailTarget): Promise<string[]> {
  const rows = await queryOne<{ domains: string | null }>(
    target,
    `SELECT string_agg(domain, ',' ORDER BY domain) AS domains FROM domain WHERE active = 1`,
  );
  return (rows?.domains ?? "").split(",").filter(Boolean);
}

/**
 * Bring the engine's armed rows in line with the rules that exist.
 *
 * This is the answer to the atomicity gap in this file's header, and it runs on a
 * schedule rather than only on write. Two drifts it repairs:
 *
 *   - a domain that SHOULD be armed but is not (a failed arm, or a new domain that a
 *     `scope: "all"` rule now covers — there is no global BCC in the shipped config, so
 *     `all` is a genuine per-domain fan-out and a domain added later is invisible
 *     until something re-arms it);
 *   - a domain armed with OUR token that no enabled rule wants any more, which would
 *     otherwise keep copying mail into a folder nobody reads, forever, on a bind mount
 *     with no quota of its own.
 *
 * A foreign BCC is reported, never touched.
 */
export async function reconcileDomains(
  target: MailTarget,
  wanted: { domains: Set<string>; all: boolean },
): Promise<{ armed: string[]; disarmed: string[]; refused: string[] }> {
  const engineDomains = await listEngineDomains(target);
  const shouldArm = wanted.all ? new Set(engineDomains) : wanted.domains;

  const armed: string[] = [];
  const disarmed: string[] = [];
  const refused: string[] = [];

  for (const d of engineDomains) {
    const state = await readArmedState(target, d).catch(() => null);
    if (!state) continue;

    if (shouldArm.has(d)) {
      if (state.foreign) {
        refused.push(d);
        continue;
      }
      if (!state.token) {
        await armDomain(target, d).then(() => armed.push(d)).catch(() => refused.push(d));
      }
      continue;
    }
    if (state.token) {
      await disarmDomain(target, d).then(() => disarmed.push(d)).catch(() => undefined);
    }
  }
  return { armed, disarmed, refused };
}

/**
 * The collector folder for a token, as an absolute path inside the engine.
 *
 * Maildir++ layout: the LDA's `-m <extension>` creates a folder named for the token, and
 * Maildir++ stores a top-level folder as a DOT-PREFIXED directory beside `cur/new/tmp`.
 * `mail_location = maildir:%Lh/Maildir/` puts the whole tree one level under the home.
 */
export function collectorFolderPath(maildirPath: string, token: string): string {
  const home = maildirPath.replace(/\/+$/, "");
  return `${home}/Maildir/.${token}`;
}

export { mailEngineCommand, runMailCommand };
