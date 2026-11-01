import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { resolve } from 'node:path';
import type { AppContext } from '../src/ctx';
import * as imap from '../src/lib/imap';
import { mailRouter } from '../src/trpc/routes/mail';

const ctx = {
  session: {
    sessionId: 'session-1', email: 'user@example.com', name: 'User', password: 'password',
    imapHost: 'imap.example.com', imapPort: 993, smtpHost: 'smtp.example.com', smtpPort: 465,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  },
  imap: { host: 'imap.example.com', port: 993, user: 'user@example.com', pass: 'password' },
  smtp: { host: 'smtp.example.com', port: 465, user: 'user@example.com', pass: 'password' },
  hono: null,
} satisfies AppContext;
const caller = mailRouter.createCaller(ctx);

// Exercise the client action through the real tRPC validation and IMAP driver;
// only the browser provider and network connection are substituted.
mock.module(resolve(import.meta.dir, '../../client/providers/query-provider.tsx'), () => ({
  trpcClient: { mail: {
    bulkDelete: { mutate: caller.bulkDelete },
    modifyLabels: { mutate: caller.modifyLabels },
  } },
}));
mock.module(resolve(import.meta.dir, '../../client/lib/utils.ts'), () => ({
  FOLDERS: { INBOX: 'inbox', BIN: 'bin', SPAM: 'spam', ARCHIVE: 'archive' },
  LABELS: { INBOX: 'INBOX', TRASH: 'TRASH', SPAM: 'SPAM', SNOOZED: 'SNOOZED' },
}));
const { moveThreadsTo } = await import('../../client/lib/thread-actions');

let selected = '';
let failMove = false;
let mailboxes: Map<string, Set<number>>;
let messageIds: Map<number, string>;
let flags: Map<string, Set<string>>;
let refuseMutation = false;
const release = mock(() => {});
const flagKey = (uid: number) => `${selected}:${uid}`;
function message(uid: number) {
  if (!mailboxes.get(selected)?.has(uid)) return false;
  const messageId = messageIds.get(uid);
  return {
    uid,
    envelope: { messageId, subject: messageId },
    flags: flags.get(flagKey(uid)) ?? new Set<string>(),
    source: Buffer.from(`Message-ID: ${messageId}\r\nSubject: ${messageId}\r\n\r\nTest body`),
  };
}
const client = {
  mailbox: { uidValidity: 1 },
  mailboxCreate: async (path: string) => {
    if (!mailboxes.has(path)) mailboxes.set(path, new Set());
  },
  getMailboxLock: async (mailbox: string) => {
    selected = mailbox;
    return { release };
  },
  // IMAP HEADER searches are case-insensitive substring matches, not equality.
  search: async (filter: { header: { 'message-id': string } }) =>
    [...mailboxes.get(selected)!].filter((uid) =>
      messageIds.get(uid)?.toLowerCase().includes(filter.header['message-id'].toLowerCase()),
    ),
  fetch: async function* (uids: number[]) {
    for (const uid of uids) {
      const result = message(uid);
      if (result) yield result;
    }
  },
  fetchOne: async (uid: string) => message(Number(uid)),
  messageMove: async (uids: number[], destination: string) => {
    if (failMove) throw new Error('IMAP move rejected');
    if (refuseMutation) return false;
    for (const uid of uids) {
      if (mailboxes.get(selected)!.delete(uid)) mailboxes.get(destination)!.add(uid);
    }
    return { uidValidity: 1, uidMap: new Map(uids.map((uid) => [uid, uid])) };
  },
  messageDelete: async (uids: number[]) => {
    if (refuseMutation) return false;
    for (const uid of uids) mailboxes.get(selected)!.delete(uid);
    return true;
  },
  messageFlagsAdd: async (uids: number[], added: string[]) => {
    if (refuseMutation) return false;
    for (const uid of uids) {
      const current = flags.get(flagKey(uid)) ?? new Set<string>();
      for (const flag of added) current.add(flag);
      flags.set(flagKey(uid), current);
    }
    return true;
  },
  messageFlagsRemove: async (uids: number[], removed: string[]) => {
    if (refuseMutation) return false;
    for (const uid of uids) {
      for (const flag of removed) flags.get(flagKey(uid))?.delete(flag);
    }
    return true;
  },
};
const connection = spyOn(imap, 'withImap');

beforeEach(() => {
  selected = '';
  failMove = false;
  refuseMutation = false;
  messageIds = new Map([[42, '<6044072238196767142@google.com>']]);
  flags = new Map();
  mailboxes = new Map([
    ['INBOX', new Set([42])], ['Sent', new Set([42])], ['Trash', new Set<number>()],
    ['Junk', new Set<number>()],
  ]);
  release.mockClear();
  connection.mockClear();
  connection.mockImplementation(async (_auth, fn) => fn(client as never));
});
afterAll(() => connection.mockRestore());

describe('webmail deletion (#429)', () => {
  it('moves an inbox message to Trash, then permanently deletes it from Bin', async () => {
    await moveThreadsTo({ threadIds: ['uid:42'], currentFolder: 'inbox', destination: 'bin' });
    expect([...mailboxes.get('INBOX')!]).toEqual([]);
    expect([...mailboxes.get('Trash')!]).toEqual([42]);

    await moveThreadsTo({ threadIds: ['uid:42'], currentFolder: 'bin', destination: 'bin' });
    expect([...mailboxes.get('Trash')!]).toEqual([]);
    expect([...mailboxes.get('Sent')!]).toEqual([42]);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('deletes from the selected mailbox without touching an equal UID in INBOX', async () => {
    await moveThreadsTo({ threadIds: ['uid:42'], currentFolder: 'sent', destination: 'bin' });
    expect([...mailboxes.get('Sent')!]).toEqual([]);
    expect([...mailboxes.get('INBOX')!]).toEqual([42]);
    expect([...mailboxes.get('Trash')!]).toEqual([42]);
  });

  it('surfaces an IMAP failure and releases the mailbox lock', async () => {
    failMove = true;
    await expect(moveThreadsTo({
      threadIds: ['uid:42'], currentFolder: 'inbox', destination: 'bin',
    })).rejects.toThrow('IMAP move rejected');
    expect([...mailboxes.get('INBOX')!]).toEqual([42]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not open a connection for an empty selection', async () => {
    await moveThreadsTo({ threadIds: [], currentFolder: 'inbox', destination: 'bin' });
    expect(connection).not.toHaveBeenCalled();
  });

  it('deletes a message opened through a URL-encoded deep link', async () => {
    const url = new URL(
      'https://mail.example.com/inbox?threadId=%3C6044072238196767142@google.com%3E',
    );
    await moveThreadsTo({
      threadIds: [url.searchParams.get('threadId')!],
      currentFolder: 'inbox',
      destination: 'bin',
    });
    expect([...mailboxes.get('INBOX')!]).toEqual([]);
    expect([...mailboxes.get('Trash')!]).toEqual([42]);
  });
});

describe('exact Message-ID resolution (#1286)', () => {
  function competingMessages(first: string, second: string) {
    messageIds = new Map([
      [42, first],
      [43, second],
    ]);
    mailboxes.get('INBOX')!.add(43);
  }

  it.each([
    ['<invoice%41@example.com>', '<invoiceA@example.com>'],
    ['invoice%41@example.com', '<invoiceA@example.com>'],
    ['<invoice%ZZ@example.com>', '<invoice@example.com>'],
    ['<invoice%2541@example.com>', '<invoice%41@example.com>'],
  ])('keeps literal Message-ID characters intact: %s', async (id, other) => {
    competingMessages(id, other);
    await moveThreadsTo({ threadIds: [id], currentFolder: 'inbox', destination: 'bin' });
    expect([...mailboxes.get('INBOX')!]).toEqual([43]);
    expect([...mailboxes.get('Trash')!]).toEqual([42]);
  });

  it('accepts a URL-decoded deep link without decoding its Message-ID again', async () => {
    competingMessages('<invoice%41@example.com>', '<invoiceA@example.com>');
    const url = new URL('https://mail.example.com/inbox');
    url.searchParams.set('threadId', '<invoice%41@example.com>');
    const id = new URL(url).searchParams.get('threadId')!;
    await moveThreadsTo({ threadIds: [id], currentFolder: 'inbox', destination: 'bin' });
    expect([...mailboxes.get('INBOX')!]).toEqual([43]);
    expect([...mailboxes.get('Trash')!]).toEqual([42]);
  });

  it('decodes a deep link exactly once, preserving literal percent escapes', async () => {
    competingMessages('<invoice%41@example.com>', '<invoiceA@example.com>');
    const url = new URL(
      `https://mail.example.com/inbox?threadId=${encodeURIComponent('<invoice%41@example.com>')}`,
    );
    await caller.bulkDelete({
      ids: [url.searchParams.get('threadId')!],
      folder: 'inbox',
    });
    expect([...mailboxes.get('INBOX')!]).toEqual([43]);
    expect([...mailboxes.get('Trash')!]).toEqual([42]);
  });

  it('does not reinterpret an encoded-looking literal ID on a repeated action', async () => {
    competingMessages('%3Cinvoice@example.com%3E', '<invoice@example.com>');
    await caller.bulkDelete({ ids: ['%3Cinvoice@example.com%3E'], folder: 'inbox' });
    expect([...mailboxes.get('INBOX')!]).toEqual([43]);
    expect([...mailboxes.get('Trash')!]).toEqual([42]);
    await expect(
      caller.bulkDelete({
        ids: ['%3Cinvoice@example.com%3E'],
        folder: 'inbox',
      }),
    ).rejects.toThrow('Message not found');
    expect([...mailboxes.get('INBOX')!]).toEqual([43]);
  });

  it.each([
    ['<invoice@example.com>', '<otherinvoice@example.com>'],
    ['<Invoice@example.com>', '<invoice@example.com>'],
    ['<invoice@example.com>', '<invoice@example.com.extra>'],
  ])('permanently deletes only the exact ID: %s versus %s', async (id, other) => {
    competingMessages(id, other);
    mailboxes.set('Trash', new Set([42, 43]));
    await caller.bulkDelete({ ids: [id], folder: 'bin' });
    expect([...mailboxes.get('Trash')!]).toEqual([43]);
    expect([...mailboxes.get('INBOX')!]).toEqual([42, 43]);
  });

  it.each(['<invoice@example.com>', '<>', '%3C%3E', '%253Cinvoice%2540example.com%253E'])(
    'rejects a missing or empty identity instead of deleting other messages: %s',
    async (id) => {
      messageIds.set(42, '<otherinvoice@example.com>');
      mailboxes.set('Trash', new Set([42]));
      await expect(caller.bulkDelete({ ids: [id], folder: 'bin' })).rejects.toThrow(
        'Message not found',
      );
      expect([...mailboxes.get('Trash')!]).toEqual([42]);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );

  it('labels the exact ID without changing a case-only or substring match', async () => {
    competingMessages('<Invoice@example.com>', '<otherInvoice@example.com>');
    messageIds.set(44, '<invoice@example.com>');
    mailboxes.get('INBOX')!.add(44);
    await caller.modifyLabels({
      ids: ['Invoice@example.com'],
      addLabels: ['Work'],
      folder: 'inbox',
    });
    expect(flags.get('INBOX:42')).toEqual(new Set(['Work']));
    expect(flags.has('INBOX:43')).toBe(false);
    expect(flags.has('INBOX:44')).toBe(false);
  });

  it('reports missing label targets instead of confirming an unchanged message', async () => {
    messageIds.set(42, '<otherinvoice@example.com>');
    await expect(
      caller.modifyLabels({
        ids: ['<invoice@example.com>'],
        addLabels: ['Work'],
        folder: 'inbox',
      }),
    ).rejects.toThrow('Message not found');
    expect(flags.size).toBe(0);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('sets flags through the same exact lookup', async () => {
    competingMessages('<Invoice@example.com>', '<invoice@example.com>');
    await caller.markAsRead({ ids: ['<Invoice@example.com>'], folder: 'inbox' });
    expect(flags.get('INBOX:42')).toEqual(new Set(['\\Seen']));
    expect(flags.has('INBOX:43')).toBe(false);
  });

  it('rejects a stale UID hint and reads the exact Message-ID', async () => {
    competingMessages('<invoice%41@example.com>', '<invoiceA@example.com>');
    const result = await caller.get({
      id: '<invoice%41@example.com>',
      folder: 'inbox',
      uidHint: { uid: 43, uidValidity: 1 },
    });
    expect(result.latest.subject).toBe('<invoice%41@example.com>');
  });

  it('finds the exact read result among substring matches with no UID hint', async () => {
    competingMessages('<invoice@example.com>', '<otherinvoice@example.com>');
    const result = await caller.get({ id: '<invoice@example.com>', folder: 'inbox' });
    expect(result.latest.subject).toBe('<invoice@example.com>');
  });

  it('reads a deep link with an unbracketed IMAP envelope', async () => {
    messageIds.set(42, '6044072238196767142@google.com');
    const url = new URL(
      'https://mail.example.com/inbox?threadId=%3C6044072238196767142@google.com%3E',
    );
    const result = await caller.get({
      id: url.searchParams.get('threadId')!,
      folder: 'inbox',
    });
    expect(result.latest.subject).toBe('6044072238196767142@google.com');
  });

  it('accepts a valid UID hint without starting a mailbox search', async () => {
    const search = spyOn(client, 'search');
    try {
      const result = await caller.get({
        id: '6044072238196767142@google.com',
        folder: 'inbox',
        uidHint: { uid: 42, uidValidity: 1 },
      });
      expect(result.latest.subject).toBe('<6044072238196767142@google.com>');
      expect(search).not.toHaveBeenCalled();
    } finally {
      search.mockRestore();
    }
  });

  it.each(['delete', 'move', 'label', 'unlabel'] as const)(
    'reports an IMAP refusal instead of confirming %s',
    async (operation) => {
      refuseMutation = true;
      const result =
        operation === 'delete'
          ? caller.bulkDelete({ ids: ['uid:42'], folder: 'bin' })
          : operation === 'move'
            ? caller.bulkDelete({ ids: ['uid:42'], folder: 'inbox' })
            : caller.modifyLabels({
                ids: ['uid:42'],
                folder: 'inbox',
                ...(operation === 'label' ? { addLabels: ['Work'] } : { removeLabels: ['Work'] }),
              });
      await expect(result).rejects.toThrow('IMAP refused');
      expect([...mailboxes.get('INBOX')!]).toEqual([42]);
      expect(release).toHaveBeenCalledTimes(1);
    },
  );
});

describe('webmail spam and archive moves (#980)', () => {
  it('moves to Junk and back to INBOX', async () => {
    await moveThreadsTo({ threadIds: ['uid:42'], currentFolder: 'inbox', destination: 'spam' });
    expect([...mailboxes.get('Junk')!]).toEqual([42]);

    await moveThreadsTo({ threadIds: ['uid:42'], currentFolder: 'spam', destination: 'inbox' });
    expect([...mailboxes.get('Junk')!]).toEqual([]);
    expect([...mailboxes.get('INBOX')!]).toEqual([42]);
  });

  it('archives into Archive, creating it when missing', async () => {
    await moveThreadsTo({ threadIds: ['uid:42'], currentFolder: 'inbox', destination: 'archive' });
    expect([...mailboxes.get('INBOX')!]).toEqual([]);
    expect([...mailboxes.get('Archive')!]).toEqual([42]);
  });

  it('keeps a message in place when a user label is removed', async () => {
    await caller.modifyLabels({ ids: ['uid:42'], removeLabels: ['Work'] });
    expect([...mailboxes.get('INBOX')!]).toEqual([42]);
  });
});
