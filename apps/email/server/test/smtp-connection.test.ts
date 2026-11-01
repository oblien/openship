import { afterAll, afterEach, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import net from 'node:net';
import dns from 'node:dns';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { sendMail } from '../src/lib/smtp';

let dir: string;
let cert: Buffer;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'openship-test-smtp-'));
  writeFileSync(
    join(dir, 'openssl.cnf'),
    '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=cert\n[dn]\nCN=localhost\n[cert]\nsubjectAltName=DNS:localhost\nbasicConstraints=critical,CA:TRUE\n',
  );
  const result = spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-config',
    join(dir, 'openssl.cnf'),
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
  ]);
  if (result.status !== 0) throw new Error(`Test certificate generation failed: ${result.stderr}`);
  cert = readFileSync(join(dir, 'cert.pem'));
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => mock.restore());

async function localSmtp(mode: 'tls' | 'starttls' | 'plaintext') {
  // Use Node's TLS server to test the shipped Bun client, including STARTTLS.
  const child = spawn('node', [join(import.meta.dir, 'fixtures/smtp-server.mjs'), mode, dir], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const credentials: { credential: string; secure: boolean }[] = [];
  const deliveries: { delivered: boolean; secure: boolean }[] = [];
  const commands: string[] = [];
  const sockets = { size: 0 };
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const lines = createInterface({ input: child.stdout });
  const port = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error(`SMTP fixture exited: ${stderr}`)));
    lines.on('line', (line) => {
      const event = JSON.parse(line);
      if (event.port) resolve(event.port);
      if (event.credential) credentials.push(event);
      if (event.delivered) deliveries.push(event);
      if (event.command) commands.push(event.command);
      if (event.connection) sockets.size += event.connection;
    });
  });
  return {
    port,
    credentials,
    deliveries,
    commands,
    sockets,
    async close() {
      child.stdin.end('stop\n');
      const deadline = setTimeout(() => child.kill(), 1000);
      try {
        await exited;
      } finally {
        clearTimeout(deadline);
        lines.close();
      }
    },
  };
}

function routeTo(port: number, trust = true) {
  const connect = net.createConnection;
  const createTransport = nodemailer.createTransport;
  // Only redirect the TCP port to the fixture. Keep the logical SMTP hostname
  // and production TLS mode; explicitly trust the test CA, never skip validation.
  const connections = spyOn(net, 'createConnection').mockImplementation(
    (options: net.NetConnectOpts) => connect({ ...options, host: 'localhost', port }),
  );
  spyOn(nodemailer, 'createTransport').mockImplementation((options: SMTPTransport.Options) =>
    createTransport({ ...options, tls: { ...(trust ? { ca: cert } : {}) } }),
  );
  return connections;
}

const auth = (port = 465, host = 'localhost') => ({
  host,
  port,
  user: 'user@example.test',
  pass: 'test-only-password',
});
const message = {
  from: 'user@example.test',
  to: ['recipient@example.test'],
  subject: 'Fixture only',
  text: 'Not delivered outside the fixture.',
};
async function waitForClose(server: Awaited<ReturnType<typeof localSmtp>>) {
  const deadline = Date.now() + 1000;
  while (server.sockets.size && Date.now() < deadline) await Bun.sleep(5);
  expect(server.sockets.size).toBe(0);
}

describe('webmail submission over real local SMTP sockets', () => {
  it.each(['tls', 'starttls'] as const)(
    'sends with verified %s through the OS hostname resolver',
    async (mode) => {
      const server = await localSmtp(mode);
      try {
        const connections = routeTo(server.port);
        // Reproduce a valid but wrong DNS answer. Nodemailer must not bypass the
        // OS mapping by using this DNS-only result, as it did on the live host.
        const resolve4 = spyOn(dns, 'resolve4').mockImplementation(
          (_host: string, _options: unknown, callback: Function) => {
            callback(null, [{ address: '127.0.1.1', ttl: 60 }]);
          },
        );
        const resolve6 = spyOn(dns, 'resolve6');
        expect((await sendMail(auth(mode === 'tls' ? 465 : 587), message)).messageId).toContain(
          '@',
        );
        expect(connections).toHaveBeenCalledWith({
          host: 'localhost',
          port: mode === 'tls' ? 465 : 587,
        });
        expect(resolve4).not.toHaveBeenCalled();
        expect(resolve6).not.toHaveBeenCalled();
        // The SMTP response and fixture's JSONL travel on separate pipes. Wait
        // for its close event so the delivery report has arrived before asserting.
        await waitForClose(server);
        expect(server.credentials).toEqual([
          { credential: '\0user@example.test\0test-only-password', secure: true },
        ]);
        expect(server.deliveries).toEqual([{ delivered: true, secure: true }]);
        if (mode === 'starttls')
          expect(server.commands.indexOf('STARTTLS')).toBeLessThan(server.commands.indexOf('AUTH'));
      } finally {
        await server.close();
      }
    },
  );

  it.each(['tls', 'starttls'] as const)(
    'rejects an untrusted %s certificate without credentials',
    async (mode) => {
      const server = await localSmtp(mode);
      try {
        routeTo(server.port, false);
        await expect(sendMail(auth(mode === 'tls' ? 465 : 587), message)).rejects.toThrow();
        expect(server.credentials).toEqual([]);
        expect(server.deliveries).toEqual([]);
        await waitForClose(server);
      } finally {
        await server.close();
      }
    },
  );

  it.each(['tls', 'starttls'] as const)(
    'checks the configured hostname over %s despite a mapped socket address',
    async (mode) => {
      const server = await localSmtp(mode);
      try {
        routeTo(server.port);
        await expect(
          sendMail(auth(mode === 'tls' ? 465 : 587, 'wrong.example.test'), message),
        ).rejects.toThrow();
        expect(server.credentials).toEqual([]);
        expect(server.deliveries).toEqual([]);
        await waitForClose(server);
      } finally {
        await server.close();
      }
    },
  );

  it('refuses a STARTTLS downgrade before sending credentials', async () => {
    const server = await localSmtp('plaintext');
    try {
      routeTo(server.port);
      await expect(sendMail(auth(587), message)).rejects.toThrow();
      expect(server.commands).toContain('STARTTLS');
      expect(server.credentials).toEqual([]);
      expect(server.deliveries).toEqual([]);
      await waitForClose(server);
    } finally {
      await server.close();
    }
  });

  it('returns a refused connection without leaving a pending socket', async () => {
    const server = await localSmtp('tls');
    await server.close();
    const connections = routeTo(server.port);
    await expect(sendMail(auth(), message)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(connections.mock.results[0]!.value.destroyed).toBe(true);
  });

  it('bounds a stalled connection and destroys its socket', async () => {
    // Model a resolver which never finishes: no connect/error event arrives.
    const socket = new net.Socket();
    spyOn(net, 'createConnection').mockReturnValue(socket);
    await expect(sendMail(auth(), message)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(socket.destroyed).toBe(true);
  }, 15_000);
});
