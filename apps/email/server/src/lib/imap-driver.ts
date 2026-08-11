/**
 * The mail driver - what the tRPC routes call into.
 *
 * Today it talks straight to IMAP via `imapflow`. Earlier versions of
 * Zero abstracted this behind a `MailManager` interface so Gmail and
 * Microsoft Graph could plug in alongside; we deleted those providers
 * when we pivoted to self-hosted-only, so the abstraction is gone and
 * this file is the one implementation.
 *
 * Conventions:
 *   - `folder` is the user-facing slug ("inbox", "sent", "drafts",
 *     "trash", "spam", "starred", "all"). `folderToMailbox()` maps to
 *     the actual IMAP mailbox name.
 *   - Thread ids are the IMAP `Message-Id` of the root message; we
 *     group by Gmail's `X-GM-THRID` when available, otherwise by
 *     References/In-Reply-To chains.
 *   - All HTML bodies are passed through `sanitizeMailHtml` before
 *     being returned to the client.
 */

import { TextDecoder } from 'node:util';
import { simpleParser } from 'mailparser';
import { sanitizeMailHtml } from './sanitize';
import { withImap, type ImapAuth } from './imap';
import { sendMail, type SmtpAuth, type SendInput } from './smtp';

export type FolderSlug =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'spam'
  | 'starred'
  | 'important'
  | 'unread'
  | 'snoozed'
  | 'archive'
  | 'all';

// The client's `FOLDERS` constant (lib/utils.ts) uses some legacy slugs
// that diverge from our canonical enum: `bin → trash`, `draft → drafts`.
// Normalize on the way in so /mail/bin and /mail/draft route correctly
// instead of silently falling back to INBOX.
const FOLDER_ALIASES: Record<string, FolderSlug> = {
  bin: 'trash',
  draft: 'drafts',
  junk: 'spam',
};

const FOLDER_SLUGS: readonly FolderSlug[] = [
  'inbox',
  'sent',
  'drafts',
  'trash',
  'spam',
  'starred',
  'important',
  'unread',
  'snoozed',
  'archive',
  'all',
];

export function normalizeFolderSlug(input: string | undefined | null): FolderSlug {
  if (!input) return 'inbox';
  const lower = input.toLowerCase();
  if (lower in FOLDER_ALIASES) return FOLDER_ALIASES[lower]!;
  return (FOLDER_SLUGS as readonly string[]).includes(lower) ? (lower as FolderSlug) : 'inbox';
}

// Virtual folders are filtered views over INBOX - `starred` shows
// \Flagged messages, `snoozed` shows $Snoozed-keyworded ones, etc.
// Physical folders are Dovecot mailboxes.
const FOLDER_MAP: Record<FolderSlug, string> = {
  inbox: 'INBOX',
  sent: 'Sent',
  drafts: 'Drafts',
  trash: 'Trash',
  spam: 'Junk',
  starred: 'INBOX',
  important: 'INBOX',
  unread: 'INBOX',
  snoozed: 'INBOX',
  archive: 'Archive',
  all: 'INBOX',
};

// imapflow uses the literal "$Snoozed" keyword (custom flag) - IMAP
// keywords are case-insensitive but Dovecot normalizes on read.
export const SNOOZE_KEYWORD = '$Snoozed';

function folderToMailbox(folder: FolderSlug): string {
  return FOLDER_MAP[folder] ?? 'INBOX';
}

// Build the imapflow search criterion for a virtual folder. Returns null
// if the folder is physical (no extra filter - the mailbox itself is
// the filter).
function virtualFolderCriteria(folder: FolderSlug): Record<string, unknown> | null {
  switch (folder) {
    case 'starred':
      return { flagged: true };
    case 'important':
      return { keyword: '$Important' };
    case 'unread':
      return { seen: false };
    case 'snoozed':
      return { keyword: SNOOZE_KEYWORD };
    case 'inbox':
      // Hide snoozed messages from the regular inbox view - they're
      // still in INBOX (no real wake-up worker yet) but should disappear
      // until manually unsnoozed.
      return { unKeyword: SNOOZE_KEYWORD };
    default:
      return null;
  }
}

// The client encodes Gmail-style search operators (is:starred, has:attachment,
// from:foo@bar, etc) inside the free-text query. Without translation we'd
// pass the literal string "is:starred" to IMAP body-search and get back
// random messages whose bodies happen to contain that text. Parse the
// known operators out into imapflow criteria, and leave anything else as
// body text.
const KNOWN_FILTERS = new Set([
  'is:starred',
  'is:flagged',
  'is:unread',
  'is:read',
  'is:important',
  'has:attachment',
]);

function parseSearchQuery(q: string): { criteria: Record<string, unknown>; bodyText: string } {
  const tokens = q.trim().split(/\s+/);
  const criteria: Record<string, unknown> = {};
  const leftover: string[] = [];
  let needsAttachmentFilter = false;
  for (const raw of tokens) {
    if (!raw) continue;
    const token = raw.toLowerCase();
    if (KNOWN_FILTERS.has(token)) {
      switch (token) {
        case 'is:starred':
        case 'is:flagged':
          criteria.flagged = true;
          break;
        case 'is:unread':
          criteria.seen = false;
          break;
        case 'is:read':
          criteria.seen = true;
          break;
        case 'is:important':
          criteria.keyword = '$Important';
          break;
        case 'has:attachment':
          // IMAP has no first-class "has attachment" - we fetch
          // bodyStructure for each candidate and filter on the way out.
          needsAttachmentFilter = true;
          break;
      }
      continue;
    }
    if (token.startsWith('from:')) {
      criteria.from = raw.slice(5);
      continue;
    }
    if (token.startsWith('to:')) {
      criteria.to = raw.slice(3);
      continue;
    }
    if (token.startsWith('subject:')) {
      criteria.subject = raw.slice(8);
      continue;
    }
    leftover.push(raw);
  }
  if (needsAttachmentFilter) {
    (criteria as { _hasAttachment?: boolean })._hasAttachment = true;
  }
  return { criteria, bodyText: leftover.join(' ') };
}

export interface Address {
  name?: string;
  email: string;
}

export interface ThreadSummary {
  id: string;
  threadId: string;
  subject: string;
  snippet: string;
  from: Address;
  to: Address[];
  date: string;
  unread: boolean;
  starred: boolean;
  important: boolean;
  labels: string[];
  hasAttachment: boolean;
}

export interface MessageDetail extends ThreadSummary {
  body: string;
  bodyText: string;
  cc: Address[];
  bcc: Address[];
  inReplyTo?: string;
  // Space-joined Message-ID list (matches RFC 2822 wire format and
  // simplifies the reply composer which calls `.split(' ')` on it).
  references: string;
  attachments: AttachmentMeta[];
}

// The legacy Zero client expects a Gmail-style thread shape - `latest`
// + `messages[]` with extra per-message fields. IMAP doesn't natively
// thread, so for now every "thread" has exactly one message and
// `latest === messages[0]`. Server-side threading via JMAP or message-id
// chains can land later without changing this contract.
export interface ThreadMessage extends MessageDetail {
  isDraft: boolean;
  isUnread: boolean;
  sender: Address;
  decodedBody: string;
  receivedOn: string;
  messageId: string;
  tags: Array<{ id: string; name: string; type: string }>;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  // Client display helpers. The original Gmail-backed Zero codebase
  // populated these; we don't yet - but the client treats them as
  // required, so the driver fills them with empty strings/false so
  // every shape lines up without forcing every read site to guard.
  title: string;
  tls: boolean;
  processedHtml: string;
  blobUrl: string;
  connectionId?: string;
  replyTo?: string;
}

export interface ThreadResponse {
  id: string;
  threadId: string;
  subject: string;
  hasUnread: boolean;
  // Thread-level labels = union of keyword flags across messages. We
  // emit them as `{id, name}` objects so consumers can treat keyword
  // flags interchangeably with first-class labels.
  labels: Array<{ id: string; name: string }>;
  totalReplies: number;
  latest: ThreadMessage;
  messages: ThreadMessage[];
  // Convenience copies of `latest` fields. The reply composer reads
  // these off the thread root; mirroring them here avoids forcing
  // every client site through `.latest.*`.
  content?: string;
  to?: Address[];
  cc?: Address[];
  bcc?: Address[];
  /**
   * IMAP UID hint - the UID this thread lives at in its source folder right
   * now. UIDs are UIDVALIDITY-stable (effectively permanent on Dovecot) so
   * the client can pass them back to `mail.get` as a fast-path so the
   * server can skip the O(N) SEARCH HEADER scan.
   *
   * Always derived server-side from the same fetch that built the row -
   * never trusted as the canonical identity (that's `messageId`).
   */
  uid?: number;
  /**
   * UIDVALIDITY of the mailbox at the moment the UID was captured. If the
   * client's hint carries a stale value (admin recreated the mailbox or
   * server returned a new UIDVALIDITY), the server falls back to the slow
   * Message-Id lookup.
   */
  uidValidity?: number;
}

export interface AttachmentMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  inline: boolean;
  // Legacy ParsedMessage attachment fields the client still reads.
  // `body` (base64) is empty on list/thread reads - the download
  // path returns it separately. Keeping them required-with-empty
  // default keeps the client's `{body, mimeType, ...}` signatures
  // satisfied without touching consumers.
  body: string;
  mimeType: string;
  attachmentId: string;
  headers: Array<{ name?: string | null; value?: string | null }>;
}

export interface ListThreadsInput {
  folder: FolderSlug;
  cursor?: string;
  limit?: number;
  q?: string;
  labelIds?: string[];
}

// Each row in the inbox table is a `ThreadResponse` shaped like a Gmail
// thread (latest message + count). We don't actually expand multiple
// messages here - the list view only needs envelope-level data - so the
// `messages` array always has length 1 and `totalReplies` is 0.
export type ListThreadsItem = ThreadResponse;

export interface ListThreadsResult {
  threads: ListThreadsItem[];
  nextPageToken: string | null;
}

const DEFAULT_LIMIT = 30;

const EMPTY_ADDR: Address = { email: '' };

function addrOne(a: { name?: string; address?: string } | undefined): Address | null {
  if (!a?.address) return null;
  return a.name ? { name: a.name, email: a.address } : { email: a.address };
}

function addrOneOrEmpty(a: { name?: string; address?: string } | undefined): Address {
  return addrOne(a) ?? EMPTY_ADDR;
}

function joinReferences(refs: unknown): string {
  if (!refs) return '';
  if (Array.isArray(refs)) return refs.join(' ');
  return String(refs);
}

function addrMany(
  list: ReadonlyArray<{ name?: string; address?: string }> | undefined,
): Address[] {
  return (list ?? [])
    .map((x) => addrOne(x))
    .filter((x): x is Address => x !== null);
}

function toIso(d: string | Date | undefined): string {
  if (!d) return new Date().toISOString();
  if (typeof d === 'string') {
    const parsed = new Date(d);
    return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  }
  return d.toISOString();
}

export async function listThreads(
  auth: ImapAuth,
  input: ListThreadsInput,
): Promise<ListThreadsResult> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const cursor = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
  const mailbox = folderToMailbox(input.folder);

  return withImap(auth, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      // Pull `uidValidity` and `exists` from the SELECT response that
      // `getMailboxLock` just performed - `client.mailbox` is populated
      // from it. We must NOT call `client.status(mailbox, …)` here: RFC
      // 3501 §6.3.10 forbids STATUS on the currently-selected mailbox,
      // and Dovecot's behavior is version-dependent (some return BAD,
      // some block, some deadlock under load - exact match for the
      // "sometimes hangs" symptom users hit on getThread).
      const mailboxState = client.mailbox as
        | { exists?: number; uidValidity?: number | bigint }
        | undefined
        | false;
      const total =
        mailboxState && typeof mailboxState === 'object' ? mailboxState.exists ?? 0 : 0;
      const rawValidity =
        mailboxState && typeof mailboxState === 'object'
          ? mailboxState.uidValidity
          : undefined;
      const uidValidity =
        typeof rawValidity === 'bigint'
          ? Number(rawValidity)
          : (rawValidity as number | undefined);
      if (total === 0) return { threads: [], nextPageToken: null };

      // Decide between sequence-based pagination (fast) and search-based
      // (required for virtual folders, search queries, or hiding snoozed
      // from inbox). Search returns UIDs newest-last-in-array? No -
      // returns ascending UIDs, we reverse on render.
      const criteria = virtualFolderCriteria(input.folder);
      const hasQuery = !!(input.q && input.q.trim().length);
      const useSearch = criteria !== null || hasQuery;

      let fetchRange: string;
      let totalMatching: number;
      let useUid: boolean;

      if (useSearch) {
        const searchOpts: Record<string, unknown> = { ...(criteria ?? {}) };
        let postFilterAttachment = false;
        if (hasQuery) {
          // Gmail-style operators (is:starred, has:attachment, from:..., …)
          // map onto real IMAP search criteria. Anything left over is
          // genuine free text and goes through `body` search.
          const parsed = parseSearchQuery(input.q!);
          const { _hasAttachment, ...realCriteria } = parsed.criteria as {
            _hasAttachment?: boolean;
            [k: string]: unknown;
          };
          postFilterAttachment = !!_hasAttachment;
          Object.assign(searchOpts, realCriteria);
          if (parsed.bodyText) {
            searchOpts.body = parsed.bodyText;
          }
        }
        const searchResult = await client.search(searchOpts, { uid: true });
        let uids: number[] = Array.isArray(searchResult) ? searchResult : [];
        if (postFilterAttachment && uids.length > 0) {
          const filtered: number[] = [];
          for await (const msg of client.fetch(
            uids.join(','),
            { bodyStructure: true },
            { uid: true },
          )) {
            if (hasAttachmentStructure(msg.bodyStructure)) filtered.push(msg.uid as number);
          }
          uids = filtered;
        }
        totalMatching = uids.length;
        if (totalMatching === 0) return { threads: [], nextPageToken: null };

        // UIDs come back ascending - take the newest window.
        const end = totalMatching - cursor;
        const start = Math.max(0, end - limit);
        const window = uids.slice(start, end);
        if (window.length === 0) return { threads: [], nextPageToken: null };
        fetchRange = window.join(',');
        useUid = true;
      } else {
        // IMAP sequence numbers ascend from oldest → newest. Page from
        // the top (newest first) by computing the inclusive sequence
        // range and inverting on render.
        const end = total - cursor;
        const start = Math.max(1, end - limit + 1);
        if (end < 1) return { threads: [], nextPageToken: null };
        fetchRange = `${start}:${end}`;
        totalMatching = total;
        useUid = false;
      }

      const threads: ListThreadsItem[] = [];
      for await (const msg of client.fetch(
        fetchRange,
        {
          envelope: true,
          flags: true,
          internalDate: true,
          bodyStructure: true,
          // Bounded partial fetch for the list-row snippet - see
          // `extractListSnippet`. This rides along in the SAME fetch
          // command as everything else in this page, so it costs no
          // additional round trip.
          bodyParts: [LIST_SNIPPET_BODY_PART],
        },
        { uid: useUid },
      )) {
        const env = msg.envelope;
        if (!env) continue;
        const starred = msg.flags?.has('\\Flagged') ?? false;
        const unread = !(msg.flags?.has('\\Seen') ?? false);
        const isDraft = msg.flags?.has('\\Draft') ?? false;
        // Surface the flag state we read for each message so we can
        // confirm whether mark-as-read is actually persisting on disk
        // vs the row reverting because of a client cache miss.
        if (process.env.MAIL_LIST_DEBUG === '1') {
          console.log(
            `[listThreads] seq=${msg.seq} uid=${msg.uid} unread=${unread} flags=${[...(msg.flags ?? [])].join(',')}`,
          );
        }
        const important =
          msg.flags?.has('$Important') === true || msg.flags?.has('Important') === true;
        // Prefer the RFC 822 Message-Id (stable across sessions). When the
        // message lacks one - common for drafts written by other clients -
        // fall back to a UID-prefixed handle. UIDs are UIDVALIDITY-stable
        // (effectively permanent), while sequence numbers shift after any
        // EXPUNGE and make follow-up lookups (`getThread`, `modifyFlag`)
        // miss. `drafts.list` already uses this exact format.
        const messageId = env.messageId ?? (msg.uid ? `uid:${msg.uid}` : `seq-${msg.seq}`);
        const labels = [...(msg.flags ?? [])].filter((f) => !f.startsWith('\\'));
        const tagFlags = labels.map((name) => ({ id: name, name, type: 'user' }));
        if (starred) tagFlags.push({ id: 'STARRED', name: 'STARRED', type: 'system' });
        if (important) tagFlags.push({ id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' });
        const sender = addrOneOrEmpty(env.from?.[0]);
        const dateIso = toIso(env.date ?? msg.internalDate);
        const subject = env.subject ?? '(no subject)';
        const hasAttachment = hasAttachmentStructure(msg.bodyStructure);

        const latest: ThreadMessage = {
          id: messageId,
          threadId: messageId,
          messageId,
          subject,
          snippet: extractListSnippet(msg.bodyParts, msg.bodyStructure),
          from: sender,
          sender,
          to: addrMany(env.to),
          cc: addrMany(env.cc),
          bcc: addrMany(env.bcc),
          date: dateIso,
          receivedOn: dateIso,
          unread,
          isUnread: unread,
          isDraft,
          starred,
          important,
          labels,
          tags: tagFlags,
          hasAttachment,
          body: '',
          bodyText: '',
          decodedBody: '',
          references: '',
          attachments: [],
          title: subject,
          tls: false,
          processedHtml: '',
          blobUrl: '',
        };

        threads.push({
          id: messageId,
          threadId: messageId,
          subject,
          hasUnread: unread,
          labels: tagFlags,
          totalReplies: 0,
          latest,
          messages: [latest],
          // UID hint - lets the next `mail.get` skip the SEARCH HEADER scan.
          // Both fields must be present together for the server to accept
          // the hint; missing UIDVALIDITY = treat the hint as untrusted.
          uid: typeof msg.uid === 'number' ? msg.uid : undefined,
          uidValidity,
        });
      }

      threads.reverse();

      const nextCursor = cursor + limit;
      const nextPageToken = nextCursor < totalMatching ? String(nextCursor) : null;
      return { threads, nextPageToken };
    } finally {
      lock.release();
    }
  });
}

function hasAttachmentStructure(struct: unknown): boolean {
  if (!struct || typeof struct !== 'object') return false;
  const s = struct as { childNodes?: unknown[]; disposition?: string };
  if (s.disposition === 'attachment') return true;
  if (Array.isArray(s.childNodes)) return s.childNodes.some(hasAttachmentStructure);
  return false;
}

// ---------------------------------------------------------------------
// List-view snippet extraction
// ---------------------------------------------------------------------

/**
 * Body-part request for the list-view snippet: RFC 3501's TEXT section
 * (everything after the top-level RFC822 headers), bounded to a small byte
 * range via IMAP partial fetch. We deliberately do NOT request a numbered
 * MIME part (e.g. "1") - a single `client.fetch()` call applies the SAME
 * body-part list to every message in the page, but different messages in a
 * page can have completely different MIME structures (single-part,
 * multipart/alternative, multipart/mixed with an attachment part first,
 * ...), so there is no one part number that's correct for all of them.
 * TEXT is structure-agnostic and guaranteed to exist on every message,
 * which is what makes fetching the snippet in the SAME batched command as
 * envelope/flags/bodyStructure possible at all (no per-message round trip).
 */
const LIST_SNIPPET_BODY_PART = { key: 'TEXT', start: 0, maxLength: 320 } as const;
// The key imapflow stores the above under in `message.bodyParts` - see
// imapflow/lib/tools.js `formatMessageResponse`: the response map key is
// the section name lowercased with the `<offset>` suffix stripped, i.e.
// "TEXT" -> "text".
const LIST_SNIPPET_MAP_KEY = 'text';
const LIST_SNIPPET_MAX_CHARS = 140;

interface LeafPartInfo {
  type: string;
  encoding: string;
  charset: string | undefined;
}

/**
 * Descend into `childNodes[0]` (the MIME convention puts the "primary"
 * alternative first, e.g. multipart/alternative lists text/plain before
 * text/html) until we hit a non-multipart leaf. Returns both the leaf's
 * type/encoding/charset (so we know how to decode the bytes BODY[TEXT]
 * handed us) and the nesting depth (so we know how many "boundary + part
 * headers" blocks precede the leaf's actual content in those raw bytes).
 * Depth is capped defensively - real messages are only ever a couple
 * levels deep.
 */
function resolveLeafPart(struct: unknown, depth = 0): { leaf: LeafPartInfo | null; depth: number } {
  if (!struct || typeof struct !== 'object' || depth > 4) return { leaf: null, depth };
  const s = struct as {
    type?: string;
    encoding?: string;
    parameters?: Record<string, unknown>;
    childNodes?: unknown[];
  };
  if (typeof s.type !== 'string') return { leaf: null, depth };
  if (s.type.startsWith('multipart/')) {
    if (!Array.isArray(s.childNodes) || s.childNodes.length === 0) return { leaf: null, depth };
    return resolveLeafPart(s.childNodes[0], depth + 1);
  }
  const charset = s.parameters?.charset;
  return {
    leaf: {
      type: s.type,
      encoding: (s.encoding ?? '7bit').toLowerCase(),
      charset: typeof charset === 'string' ? charset.trim().toLowerCase() : undefined,
    },
    depth,
  };
}

/**
 * Charset labels routed to `Buffer.toString('utf8')` rather than to
 * TextDecoder. The ASCII labels sit here because WHATWG resolves them to
 * windows-1252, which mangles a part that declares ASCII but carries
 * UTF-8 bytes.
 */
const UTF8_COMPATIBLE_CHARSETS = new Set(['utf-8', 'utf8', 'us-ascii', 'ascii']);

/**
 * Decode part bytes using the charset declared in the part's MIME
 * parameters. Labels TextDecoder does not know throw, in which case we
 * fall back to utf8.
 */
function decodeCharset(bytes: Buffer, charset: string | undefined): string {
  if (!charset || UTF8_COMPATIBLE_CHARSETS.has(charset)) return bytes.toString('utf8');
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  laquo: '«',
  raquo: '»',
};

/**
 * Resolve HTML character references in a single left-to-right pass, so an
 * already-escaped reference like `&amp;lt;` decodes to the literal text
 * `&lt;` rather than to `<`. Anything that isn't a reference we recognise
 * is left verbatim.
 */
function decodeHtmlEntities(text: string): string {
  const reference = /&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi;
  return text.replace(reference, (match, ref: string) => {
    if (!ref.startsWith('#')) return HTML_ENTITIES[ref.toLowerCase()] ?? match;
    const hex = ref[1] === 'x' || ref[1] === 'X';
    const code = parseInt(hex ? ref.slice(2) : ref.slice(1), hex ? 16 : 10);
    if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
    return String.fromCodePoint(code);
  });
}

/**
 * Byte-level quoted-printable decode (soft line breaks + `=XX` escapes).
 * Operates on raw bytes rather than a decoded string so multi-byte UTF-8
 * sequences (e.g. a curly quote encoded as "=E2=80=99") decode correctly
 * instead of turning into mojibake.
 */
function decodeQuotedPrintableBytes(raw: Buffer): Buffer {
  const ascii = raw.toString('latin1').replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < ascii.length; i++) {
    const hex = ascii.slice(i + 1, i + 3);
    if (ascii[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(ascii.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * Build the 1-line list-row snippet from the bounded BODY[TEXT] partial
 * fetch requested alongside envelope/flags/bodyStructure in `listThreads`.
 * Best-effort only: the fetch is capped at a few hundred bytes (cheap -
 * that's the whole point of IMAP partial fetch), so on multipart messages
 * we may only capture MIME boundary/header noise before real content
 * starts, or truncate mid-word/mid-character. Any failure here must NEVER
 * break the list - this always degrades to '' rather than throwing, and
 * the client falls back to the subject line when snippet is empty.
 */
export function extractListSnippet(
  bodyParts: Map<string, Buffer> | undefined,
  bodyStructure: unknown,
): string {
  try {
    const raw = bodyParts?.get(LIST_SNIPPET_MAP_KEY);
    if (!raw || raw.length === 0) return '';

    const { leaf, depth } = resolveLeafPart(bodyStructure);
    // BODY[TEXT] lands on whatever part comes first, and on S/MIME,
    // PGP/MIME or attachment-first messages that part is binary - there is
    // no snippet to be had from it.
    if (leaf && !leaf.type.startsWith('text/')) return '';

    let bytes = raw;
    // BODY[TEXT] on a multipart message returns the raw MIME body -
    // boundary line + part headers included, one such block per nesting
    // level - since TEXT can't target a specific sub-part directly. Skip
    // past `depth` header blocks so we land on the leaf part's content.
    for (let i = 0; i < depth; i++) {
      const text = bytes.toString('latin1');
      const blankLine = text.indexOf('\r\n\r\n');
      const idx = blankLine !== -1 ? blankLine + 4 : text.indexOf('\n\n') + 2;
      if (idx <= 1) return ''; // ran out of budget before reaching real content
      bytes = Buffer.from(text.slice(idx), 'latin1');
    }
    if (bytes.length === 0) return '';

    // The fetch window is a flat byte range across the whole multipart body,
    // not scoped to a single part - short leaf content commonly leaves
    // budget that runs past this part's end into the NEXT part's boundary
    // line + headers (e.g. a one-sentence body followed by an attachment).
    // A MIME boundary is always its own line starting with "--" and is never
    // itself encoded (base64's alphabet excludes "-"), so cut there before
    // decoding rather than let it leak into the snippet.
    const rawLatin1 = bytes.toString('latin1');
    const nextBoundaryAt = rawLatin1.search(/\r?\n--/);
    if (nextBoundaryAt !== -1) {
      bytes = Buffer.from(rawLatin1.slice(0, nextBoundaryAt), 'latin1');
    }
    if (bytes.length === 0) return '';

    const encoding = leaf?.encoding ?? '7bit';
    const decoded =
      encoding === 'quoted-printable'
        ? decodeQuotedPrintableBytes(bytes)
        : encoding === 'base64'
          ? Buffer.from(bytes.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
          : bytes;

    // drop a truncated trailing char
    let text = decodeCharset(decoded, leaf?.charset).replace(/�+$/, '');
    if (leaf?.type === 'text/html' || /<[a-z][\s\S]*>/i.test(text)) {
      text = decodeHtmlEntities(
        text
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          // The fetch window is byte-bounded, so an HTML message's markup
          // commonly gets cut mid-tag (e.g. `<div style="margin-top`, no
          // closing `>` yet) - the rule above needs a full `<...>` pair to
          // match, so a dangling tag at the very end survives as literal
          // text. Strip it too.
          .replace(/<[^>]*$/, ' '),
      );
    }
    text = text.replace(/\s+/g, ' ').trim();

    // Leftover MIME noise guard - if what's left still looks like a
    // header line or a boundary marker, we didn't land on real content.
    if (!text || /^(content-|--)/i.test(text)) return '';

    return text.slice(0, LIST_SNIPPET_MAX_CHARS);
  } catch {
    return '';
  }
}

/**
 * Optional UID hint produced by `listThreads`. When the client passes one
 * back, `getThread` resolves the message in a single FETCH instead of an
 * O(N) SEARCH HEADER scan over the mailbox.
 *
 * Treated as untrusted: the server cross-checks UIDVALIDITY and the
 * resolved Message-Id before accepting the row. Any mismatch falls back
 * to the slow path.
 */
export interface UidHint {
  uid: number;
  uidValidity: number;
}

/**
 * Normalize a Message-Id for equality comparison.
 *
 * IMAP envelope Message-Ids and URL-borne Message-Ids drift in two ways:
 *   - Angle brackets: some IMAP servers strip them when populating ENVELOPE,
 *     others keep them. The URL form `?threadId=%3C...%3E` decodes WITH
 *     brackets. A bracketed vs unbracketed compare always fails for the
 *     same logical id.
 *   - Outer whitespace: rare but the spec allows it on the wire.
 *
 * Strip both before comparison so the UID-hint fast path can match
 * regardless of whether the bracketed form ended up in either side.
 * The local-part of a Message-Id is case-sensitive per RFC 5322 §3.6.4
 * so we do NOT lowercase.
 */
function normalizeMessageId(id: string | null | undefined): string {
  if (!id) return '';
  let s = id.trim();
  if (s.startsWith('<')) s = s.slice(1);
  if (s.endsWith('>')) s = s.slice(0, -1);
  return s.trim();
}

const GET_THREAD_DEBUG = process.env.IMAP_DEBUG === '1';

function gtDebug(stage: string, extra?: Record<string, unknown>) {
  if (!GET_THREAD_DEBUG) return;
  const parts = [`[getThread] ${stage}`];
  if (extra) parts.push(JSON.stringify(extra));
  console.log(parts.join(' '));
}

export async function getThread(
  auth: ImapAuth,
  id: string,
  folder: FolderSlug = 'inbox',
  hint?: UidHint,
): Promise<ThreadResponse | null> {
  const mailbox = folderToMailbox(folder);
  const startedAt = performance.now();
  const normalizedId = normalizeMessageId(id);
  gtDebug('enter', { user: auth.user, host: auth.host, folder, mailbox, hasHint: !!hint, idLen: id.length });

  return withImap(auth, async (client) => {
    const lockStart = performance.now();
    const lock = await client.getMailboxLock(mailbox);
    gtDebug('lock acquired', { ms: Math.round(performance.now() - lockStart) });
    try {
      // Primary lookup is by RFC 822 Message-Id (stable across sessions).
      // Legacy drafts surfaced from `drafts.list` with a `uid:<n>` handle
      // when they predated Message-Id stamping; resolve those by UID,
      // which is UIDVALIDITY-stable (i.e. effectively permanent). The
      // bare-numeric branch is a safety net for clients still holding
      // pre-`uid:` cached ids - drop it once they've rolled over.
      let msg;
      const uidMatch = /^uid:(\d+)$/.exec(id);
      if (uidMatch) {
        const t0 = performance.now();
        msg = await client.fetchOne(
          uidMatch[1]!,
          { source: true, envelope: true, flags: true, internalDate: true },
          { uid: true },
        );
        gtDebug('uid: path', { uid: uidMatch[1], ms: Math.round(performance.now() - t0), found: !!msg });
      } else {
        // Fast path - `listThreads` passed us a UID hint along with the
        // UIDVALIDITY it was captured against. Verify the validity matches
        // the mailbox's current value, then fetch by UID directly. We
        // compare normalized Message-Ids so angle-bracket drift between
        // list-time (envelope) and get-time (URL) doesn't reject a match.
        //
        // CRITICAL: do NOT call `client.status(mailbox, …)` here. RFC 3501
        // §6.3.10 forbids STATUS on the currently-selected mailbox, and
        // Dovecot's behavior is version-dependent (some return BAD, some
        // block on the SELECT state, some deadlock under load). We already
        // hold a SELECT via `getMailboxLock` above - imapflow populates
        // `client.mailbox.uidValidity` from the SELECT response, so just
        // read it from there. Zero round-trips, no STATUS-on-selected
        // foot-gun.
        if (hint && Number.isFinite(hint.uid) && Number.isFinite(hint.uidValidity)) {
          const mailboxState = client.mailbox as
            | { uidValidity?: number | bigint }
            | undefined
            | false;
          const rawValidity =
            mailboxState && typeof mailboxState === 'object'
              ? mailboxState.uidValidity
              : undefined;
          const currentValidity =
            typeof rawValidity === 'bigint'
              ? Number(rawValidity)
              : (rawValidity as number | undefined);
          gtDebug('hint: validity', {
            currentValidity,
            hintValidity: hint.uidValidity,
            match: currentValidity === hint.uidValidity,
          });
          if (currentValidity === hint.uidValidity) {
            const t1 = performance.now();
            const candidate = await client.fetchOne(
              String(hint.uid),
              { source: true, envelope: true, flags: true, internalDate: true },
              { uid: true },
            );
            const validCandidate =
              candidate && typeof candidate === 'object' ? candidate : null;
            const matchedMsgId = validCandidate
              ? normalizeMessageId(validCandidate.envelope?.messageId) === normalizedId
              : false;
            gtDebug('hint: fetchOne', {
              ms: Math.round(performance.now() - t1),
              found: !!validCandidate,
              envelopeMsgId: validCandidate?.envelope?.messageId,
              expectedMsgId: id,
              matched: matchedMsgId,
            });
            if (validCandidate && matchedMsgId) {
              msg = validCandidate;
            }
          }
        }
        // Slow path - SEARCH HEADER MESSAGE-ID. Walks every message in the
        // mailbox checking headers; expensive on large mailboxes without
        // FTS, which is why the hint path above exists.
        //
        // We search BOTH the bracketed and unbracketed form so the lookup
        // doesn't depend on which form the IMAP server stores internally
        // (Dovecot keeps brackets, some servers strip them).
        if (!msg) {
          const t0 = performance.now();
          let searchRaw = await client.search({ header: { 'message-id': id } }, { uid: true });
          let search: number[] = Array.isArray(searchRaw) ? searchRaw : [];
          if (search.length === 0 && normalizedId !== id) {
            // Retry without angle brackets - some servers strip them in the
            // header index even though the envelope keeps them.
            searchRaw = await client.search({ header: { 'message-id': normalizedId } }, { uid: true });
            search = Array.isArray(searchRaw) ? searchRaw : [];
          }
          gtDebug('slow: search', { ms: Math.round(performance.now() - t0), hits: search.length });
          if (search.length > 0) {
            const uid = search[search.length - 1];
            const t1 = performance.now();
            msg = await client.fetchOne(
              String(uid),
              { source: true, envelope: true, flags: true, internalDate: true },
              { uid: true },
            );
            gtDebug('slow: fetchOne', { uid, ms: Math.round(performance.now() - t1), found: !!msg });
          } else if (/^\d+$/.test(id)) {
            msg = await client.fetchOne(
              id,
              { source: true, envelope: true, flags: true, internalDate: true },
              { uid: false },
            );
            gtDebug('slow: seq fallback', { id, found: !!msg });
          }
        }
      }
      if (!msg || !msg.source) {
        gtDebug('miss', { totalMs: Math.round(performance.now() - startedAt) });
        return null;
      }
      gtDebug('hit', { totalMs: Math.round(performance.now() - startedAt), bytes: (msg.source as Buffer).length });

      const parsed = await simpleParser(msg.source as Buffer);
      const env = msg.envelope;

      const html =
        typeof parsed.html === 'string'
          ? sanitizeMailHtml(parsed.html)
          : parsed.textAsHtml
            ? sanitizeMailHtml(parsed.textAsHtml)
            : '';

      const isUnread = !(msg.flags?.has('\\Seen') ?? false);
      const isDraft = msg.flags?.has('\\Draft') ?? false;
      const tagFlags = [...(msg.flags ?? [])]
        .filter((f) => !f.startsWith('\\'))
        .map((name) => ({ id: name, name, type: 'user' }));
      if (msg.flags?.has('\\Flagged'))
        tagFlags.push({ id: 'STARRED', name: 'STARRED', type: 'system' });
      if (msg.flags?.has('$Important'))
        tagFlags.push({ id: 'IMPORTANT', name: 'IMPORTANT', type: 'system' });

      const listUnsub =
        typeof parsed.headers.get('list-unsubscribe') === 'string'
          ? (parsed.headers.get('list-unsubscribe') as string)
          : null;
      const listUnsubPost =
        typeof parsed.headers.get('list-unsubscribe-post') === 'string'
          ? (parsed.headers.get('list-unsubscribe-post') as string)
          : null;
      const sender = addrOne(env?.from?.[0]) ?? addrOneParsed(parsed.from) ?? EMPTY_ADDR;
      const dateIso = toIso(env?.date ?? parsed.date ?? undefined);

      const message: ThreadMessage = {
        id,
        threadId: id,
        messageId: id,
        subject: env?.subject ?? parsed.subject ?? '(no subject)',
        snippet: (parsed.text ?? '').slice(0, 240),
        from: sender,
        sender,
        to: addrMany(env?.to) ?? addrManyParsed(parsed.to),
        cc: addrManyParsed(parsed.cc),
        bcc: addrManyParsed(parsed.bcc),
        date: dateIso,
        receivedOn: dateIso,
        unread: isUnread,
        isUnread,
        isDraft,
        starred: msg.flags?.has('\\Flagged') ?? false,
        important: msg.flags?.has('$Important') ?? false,
        labels: [...(msg.flags ?? [])].filter((f) => !f.startsWith('\\')),
        tags: tagFlags,
        ...(listUnsub ? { listUnsubscribe: listUnsub } : {}),
        ...(listUnsubPost ? { listUnsubscribePost: listUnsubPost } : {}),
        hasAttachment: (parsed.attachments?.length ?? 0) > 0,
        body: html,
        bodyText: parsed.text ?? '',
        decodedBody: html,
        ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo } : {}),
        references: joinReferences(parsed.references),
        title: env?.subject ?? parsed.subject ?? '(no subject)',
        tls: false,
        processedHtml: html,
        blobUrl: '',
        attachments: (parsed.attachments ?? []).map((a, i) => {
          const attId = `${id}-${i}`;
          const ct = a.contentType ?? 'application/octet-stream';
          return {
            id: attId,
            filename: a.filename ?? `attachment-${i}`,
            contentType: ct,
            mimeType: ct,
            size: a.size ?? 0,
            inline: a.contentDisposition === 'inline',
            body: '',
            attachmentId: attId,
            headers: [],
          };
        }),
      };

      return {
        id,
        threadId: id,
        subject: message.subject,
        hasUnread: isUnread,
        labels: tagFlags,
        totalReplies: 0,
        latest: message,
        messages: [message],
        content: message.decodedBody,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
      };
    } finally {
      lock.release();
    }
  });
}

interface MailparserAddress {
  name?: string;
  address?: string;
  value?: ReadonlyArray<{ name?: string; address?: string }>;
}

function addrOneParsed(a: MailparserAddress | MailparserAddress[] | undefined): Address | null {
  if (!a) return null;
  const single = Array.isArray(a) ? a[0] : a;
  if (!single) return null;
  if (single.value && single.value.length > 0) return addrOne(single.value[0]);
  return addrOne({ name: single.name, address: single.address });
}

function addrManyParsed(
  a: MailparserAddress | MailparserAddress[] | undefined,
): Address[] {
  if (!a) return [];
  const arr = Array.isArray(a) ? a : [a];
  return arr.flatMap((x) => {
    if (x.value && x.value.length > 0) return addrMany(x.value);
    const one = addrOne({ name: x.name, address: x.address });
    return one ? [one] : [];
  });
}

export interface FlagInput {
  ids: string[];
  folder?: FolderSlug;
}

// Physical Dovecot mailboxes a flag-bearing message can actually live in.
// Virtual folder slugs (`starred`, `important`, …) all map to INBOX and
// don't need their own entry - we scan distinct mailbox names only.
const PHYSICAL_MAILBOXES = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Junk', 'Archive'] as const;

async function modifyFlag(
  auth: ImapAuth,
  ids: string[],
  folder: FolderSlug,
  flag: string,
  add: boolean,
): Promise<void> {
  if (ids.length === 0) return;
  const preferred = folderToMailbox(folder);
  const order: readonly string[] = preferred
    ? [preferred, ...PHYSICAL_MAILBOXES.filter((m) => m !== preferred)]
    : PHYSICAL_MAILBOXES;
  // Rows surfaced from listThreads/drafts.list use `uid:<n>` as their id
  // when the underlying message has no RFC 822 Message-Id (legacy drafts,
  // some auto-generated mail). Skip the header search and use UID lookup
  // for those.
  const uidMatch = (id: string) => {
    const m = /^uid:(\d+)$/.exec(id);
    return m ? m[1]! : null;
  };
  await withImap(auth, async (client) => {
    for (const id of ids) {
      let landed: string | null = null;
      const uidHandle = uidMatch(id);
      for (const mailbox of order) {
        let lock;
        try {
          lock = await client.getMailboxLock(mailbox);
        } catch {
          continue;
        }
        try {
          let found: number[] | undefined;
          if (uidHandle !== null) {
            // Confirm the UID exists in this mailbox before attempting
            // STORE - UIDs are mailbox-scoped, so uid 42 in INBOX is a
            // different message than uid 42 in Drafts.
            const exists = await client.fetchOne(uidHandle, { uid: true }, { uid: true });
            found = exists ? [Number(uidHandle)] : undefined;
          } else {
            const search = await client.search(
              { header: { 'message-id': id } },
              { uid: true },
            );
            found = search && search.length > 0 ? search : undefined;
          }
          if (found && found.length > 0) {
            // imapflow returns true on STORE success, false if the flag
            // couldn't be applied (read-only mailbox, server refused).
            // Without checking, mark-as-read returned 200 OK but the
            // listThreads refetch still showed unread - and we'd have
            // no log of why.
            const ok = add
              ? await client.messageFlagsAdd(found, [flag], { uid: true })
              : await client.messageFlagsRemove(found, [flag], { uid: true });
            if (!ok) {
              console.error(
                `[modifyFlag] STORE returned false: id=${id} flag=${flag} add=${add} mailbox=${mailbox} uids=${found.join(',')}`,
              );
              throw new Error(`STORE refused for ${flag}: ${id}`);
            }
            console.log(
              `[modifyFlag] ok: id=${id} flag=${flag} add=${add} mailbox=${mailbox} uids=${found.join(',')}`,
            );
            landed = mailbox;
            break;
          }
        } finally {
          lock.release();
        }
      }
      if (!landed) {
        // Silent no-ops were why mark-as-read appeared to "revert" - the
        // optimistic overlay cleared, then the listThreads refetch
        // returned the same unread state because the flag had never
        // actually been touched. Log and throw so the client surfaces a
        // real error instead of pretending success.
        console.error(
          `[modifyFlag] message-id not found in any physical mailbox: id=${id} flag=${flag} add=${add} mailboxes=${order.join(',')}`,
        );
        throw new Error(`Message not found for ${flag}: ${id}`);
      }
    }
  });
}

export async function markAsRead(auth: ImapAuth, input: FlagInput): Promise<void> {
  return modifyFlag(auth, input.ids, input.folder ?? 'inbox', '\\Seen', true);
}

export async function markAsUnread(auth: ImapAuth, input: FlagInput): Promise<void> {
  return modifyFlag(auth, input.ids, input.folder ?? 'inbox', '\\Seen', false);
}

export async function setStarred(
  auth: ImapAuth,
  input: FlagInput & { starred: boolean },
): Promise<void> {
  return modifyFlag(auth, input.ids, input.folder ?? 'inbox', '\\Flagged', input.starred);
}

export async function setImportant(
  auth: ImapAuth,
  input: FlagInput & { important: boolean },
): Promise<void> {
  return modifyFlag(auth, input.ids, input.folder ?? 'inbox', '$Important', input.important);
}

export async function deleteThreads(auth: ImapAuth, input: FlagInput): Promise<void> {
  if (input.ids.length === 0) return;
  const sourceMailbox = folderToMailbox(input.folder ?? 'inbox');
  const uidOnly = (id: string) => {
    const m = /^uid:(\d+)$/.exec(id);
    return m ? [Number(m[1])] : null;
  };
  await withImap(auth, async (client) => {
    const lock = await client.getMailboxLock(sourceMailbox);
    try {
      for (const id of input.ids) {
        let found = uidOnly(id);
        if (!found) {
          const search = await client.search(
            { header: { 'message-id': id } },
            { uid: true },
          );
          found = search && search.length > 0 ? search : null;
        }
        if (!found) continue;
        if (sourceMailbox === 'Trash') {
          await client.messageDelete(found, { uid: true });
        } else {
          await client.messageMove(found, 'Trash', { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  });
}

// Snooze: stamp the $Snoozed custom keyword on INBOX messages so they
// disappear from inbox (we exclude that keyword in listThreads/inbox)
// and surface under /mail/snoozed. The `until` timestamp is accepted by
// the API for forward-compat but not persisted yet - there's no
// wake-up worker, so messages stay snoozed until manually unsnoozed.
export async function snoozeThreads(
  auth: ImapAuth,
  input: { ids: string[]; until?: string },
): Promise<void> {
  return modifyFlag(auth, input.ids, 'inbox', SNOOZE_KEYWORD, true);
}

export async function unsnoozeThreads(
  auth: ImapAuth,
  input: { ids: string[] },
): Promise<void> {
  // After unsnooze we don't know which mailbox the message currently
  // lives in - but snoozed messages live in INBOX with $Snoozed set, so
  // INBOX is where the keyword needs to be removed.
  return modifyFlag(auth, input.ids, 'inbox', SNOOZE_KEYWORD, false);
}

export async function modifyLabels(
  auth: ImapAuth,
  input: { ids: string[]; folder?: FolderSlug; addLabels?: string[]; removeLabels?: string[] },
): Promise<void> {
  const mailbox = folderToMailbox(input.folder ?? 'inbox');
  const uidOnly = (id: string) => {
    const m = /^uid:(\d+)$/.exec(id);
    return m ? [Number(m[1])] : null;
  };
  await withImap(auth, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      for (const id of input.ids) {
        let found = uidOnly(id);
        if (!found) {
          const search = await client.search(
            { header: { 'message-id': id } },
            { uid: true },
          );
          found = search && search.length > 0 ? search : null;
        }
        if (!found) continue;
        if (input.addLabels && input.addLabels.length > 0) {
          await client.messageFlagsAdd(found, input.addLabels, { uid: true });
        }
        if (input.removeLabels && input.removeLabels.length > 0) {
          await client.messageFlagsRemove(found, input.removeLabels, { uid: true });
        }
      }
    } finally {
      lock.release();
    }
  });
}

export interface SendMailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{ name: string; type: string; base64: string }>;
}

export async function send(
  smtp: SmtpAuth,
  imap: ImapAuth,
  from: string,
  input: SendMailInput,
): Promise<{ messageId: string }> {
  const send: SendInput = {
    from,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    attachments: input.attachments?.map((a) => ({
      filename: a.name,
      content: Buffer.from(a.base64, 'base64'),
      contentType: a.type,
    })),
  };
  const result = await sendMail(smtp, send);

  // Append a copy to Sent so the user sees the message in the UI.
  // Postfix's sender_bcc would also do this, but appending lets us
  // reflect the message immediately without waiting for delivery.
  await withImap(imap, async (client) => {
    const rfc822 = buildRfc822(from, send, result.messageId);
    await client.append('Sent', rfc822, ['\\Seen']);
  }).catch(() => {
    // Best-effort: an APPEND failure shouldn't fail the send.
  });

  return result;
}

function buildRfc822(from: string, m: SendInput, messageId: string): Buffer {
  const headers = [
    `From: ${from}`,
    `To: ${m.to.join(', ')}`,
    m.cc?.length ? `Cc: ${m.cc.join(', ')}` : null,
    `Subject: ${m.subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-Id: ${messageId}`,
    m.inReplyTo ? `In-Reply-To: ${m.inReplyTo}` : null,
    m.references?.length ? `References: ${m.references.join(' ')}` : null,
    'MIME-Version: 1.0',
    m.html ? 'Content-Type: text/html; charset=UTF-8' : 'Content-Type: text/plain; charset=UTF-8',
  ]
    .filter(Boolean)
    .join('\r\n');
  return Buffer.from(`${headers}\r\n\r\n${m.html ?? m.text ?? ''}`);
}
