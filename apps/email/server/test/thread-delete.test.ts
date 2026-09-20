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
const release = mock(() => {});
const client = {
  getMailboxLock: async (mailbox: string) => {
    selected = mailbox;
    return { release };
  },
  search: async () => [...mailboxes.get(selected)!],
  messageMove: async (uids: number[], destination: string) => {
    if (failMove) throw new Error('IMAP move rejected');
    for (const uid of uids) {
      if (mailboxes.get(selected)!.delete(uid)) mailboxes.get(destination)!.add(uid);
    }
  },
  messageDelete: async (uids: number[]) => {
    for (const uid of uids) mailboxes.get(selected)!.delete(uid);
  },
  messageFlagsAdd: async () => {},
  messageFlagsRemove: async () => {},
};
const connection = spyOn(imap, 'withImap');

beforeEach(() => {
  selected = '';
  failMove = false;
  mailboxes = new Map([
    ['INBOX', new Set([42])], ['Sent', new Set([42])], ['Trash', new Set<number>()],
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
});
