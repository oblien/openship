import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { ImapFlow } from 'imapflow';
import { Hono } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { bridgeImapIdle } from '../src/lib/imap-idle';

class Mailbox extends EventEmitter {
  phase = '';
  closes = 0;
  release?: () => void;
  constructor(readonly hold = 'idle') { super(); }
  private async enter(phase: string) {
    this.phase = phase;
    if (phase === this.hold) await new Promise<void>(resolve => { this.release = resolve; });
  }
  connect = () => this.enter('connect');
  mailboxOpen = () => this.enter('mailbox');
  idle = () => this.enter('idle');
  close() {
    this.closes++;
    this.release?.();
    this.emit('close');
  }
}

async function settle() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
afterEach(() => mock.restore());

describe('IMAP IDLE stream lifetime', () => {
  it.each(['connect', 'mailbox', 'idle'])('closes an interrupted %s immediately, without waiting for IDLE renewal', async (hold) => {
    const client = new Mailbox(hold);
    const controller = new AbortController();
    const clear = spyOn(globalThis, 'clearInterval');
    const stream = { aborted: false, onAbort: mock(), writeSSE: mock(async () => {}) };
    const done = bridgeImapIdle(client as unknown as ImapFlow, stream as unknown as SSEStreamingApi, 'INBOX', controller.signal);
    await settle();
    expect(client.phase).toBe(hold);
    controller.abort();
    await done;
    expect(client.closes).toBe(1);
    expect(client.eventNames()).toEqual([]);
    expect(clear).toHaveBeenCalled();
    client.emit('exists');
    expect(stream.writeSSE).toHaveBeenCalledTimes(hold === 'idle' ? 1 : 0);
  });

  it('does not open a connection for an already aborted response', async () => {
    const client = new Mailbox();
    const stream = { aborted: true, onAbort: mock(), writeSSE: mock() };
    await bridgeImapIdle(client as unknown as ImapFlow, stream as unknown as SSEStreamingApi, 'INBOX', new AbortController().signal);
    expect(client.phase).toBe('');
    expect(client.closes).toBe(1);
    expect(client.eventNames()).toEqual([]);
  });

  it.each(['error', 'close'])('settles the stream when the IMAP client emits %s', async (event) => {
    const client = new Mailbox();
    const stream = { aborted: false, onAbort: mock(), writeSSE: mock(async () => {}) };
    const done = bridgeImapIdle(client as unknown as ImapFlow, stream as unknown as SSEStreamingApi, 'INBOX', new AbortController().signal);
    await settle();
    client.emit(event, new Error('Connection lost'));
    await done;
    expect(client.closes).toBe(1);
    expect(client.eventNames()).toEqual([]);
  });

  it('coalesces a mailbox burst and heartbeat writes while the browser is slow', async () => {
    const client = new Mailbox();
    const controller = new AbortController();
    let releaseWrite!: () => void;
    const stream = {
      aborted: false,
      onAbort: mock(),
      writeSSE: mock(() => new Promise<void>(resolve => { releaseWrite = resolve; })),
    };
    const interval = spyOn(globalThis, 'setInterval');
    const done = bridgeImapIdle(client as unknown as ImapFlow, stream as unknown as SSEStreamingApi, 'INBOX', controller.signal);
    await settle();
    for (let n = 0; n < 1000; n++) client.emit('exists');
    const beat = interval.mock.calls[0]![0] as () => void;
    for (let n = 0; n < 20; n++) beat();
    expect(stream.writeSSE).toHaveBeenCalledTimes(1);
    releaseWrite();
    await settle();
    expect(stream.writeSSE).toHaveBeenCalledTimes(2);
    controller.abort();
    releaseWrite();
    await done;
    expect(client.closes).toBe(1);
  });

  it('releases the connection when the real Hono response body is cancelled', async () => {
    const client = new Mailbox();
    let done!: Promise<void>;
    const app = new Hono().get('/', c => streamSSE(c, stream => {
      done = bridgeImapIdle(client as unknown as ImapFlow, stream, 'INBOX', c.req.raw.signal);
      return done;
    }));
    const response = await app.request('/');
    await settle();
    expect(client.phase).toBe('idle');
    await response.body!.cancel();
    await done;
    expect(client.closes).toBe(1);
    expect(client.eventNames()).toEqual([]);
  });

  it('renews real IMAP IDLE and closes its TCP socket when the browser disconnects', async () => {
    const sockets = new Set<Socket>();
    let idleCount = 0;
    const server = createServer(socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.write('* OK Test IMAP server\r\n');
      let input = '';
      let idleTag = '';
      socket.on('data', chunk => {
        input += chunk;
        let end: number;
        while ((end = input.indexOf('\r\n')) >= 0) {
          const line = input.slice(0, end);
          input = input.slice(end + 2);
          if (line === 'DONE') { socket.write(`${idleTag} OK Idle ended\r\n`); continue; }
          const [tag, command] = line.split(' ');
          if (command === 'CAPABILITY') socket.write('* CAPABILITY IMAP4.1 AUTH=PLAIN SASL-IR IDLE\r\n');
          if (command === 'LIST') socket.write('* LIST (\\Noselect) "/" ""\r\n');
          if (command === 'SELECT') socket.write('* 1 EXISTS\r\n* OK [UIDVALIDITY 1] Valid\r\n* OK [UIDNEXT 2] Next\r\n* FLAGS (\\Seen)\r\n');
          if (command === 'IDLE') {
            idleTag = tag!;
            idleCount++;
            socket.write('+ Idling\r\n');
          } else socket.write(`${tag} OK Completed\r\n`);
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const client = new ImapFlow({
      host: '127.0.0.1', port: address.port, secure: false, logger: false,
      auth: { user: 'test@example.test', pass: 'test-only' },
      disableAutoIdle: true, maxIdleTime: 50, connectionTimeout: 2000,
    });
    let done: Promise<void> | undefined;
    let response: Response | undefined;
    const app = new Hono().get('/', c => streamSSE(c, stream => {
      done = bridgeImapIdle(client, stream, 'INBOX', c.req.raw.signal);
      return done;
    }));
    try {
      response = await app.request('/');
      const deadline = Date.now() + 2000;
      while (idleCount < 2 && Date.now() < deadline) await Bun.sleep(5);
      expect(idleCount).toBeGreaterThanOrEqual(2);
      const reader = response.body!.getReader();
      const ready = await reader.read();
      expect(new TextDecoder().decode(ready.value)).toContain('event: mailbox');
      for (const socket of sockets) socket.write('* 2 EXISTS\r\n');
      const delivered = await Promise.race([
        reader.read(),
        Bun.sleep(1000).then(() => { throw new Error('IDLE notification was not forwarded'); }),
      ]);
      expect(new TextDecoder().decode(delivered.value)).toContain('event: mailbox');
      await reader.cancel();
      await done;
      while (sockets.size && Date.now() < deadline) await Bun.sleep(5);
      expect(sockets.size).toBe(0);
      expect(client.listenerCount('exists')).toBe(0);
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
