import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createTlsServer, createSecureContext, TLSSocket } from 'node:tls';

const [mode, dir] = process.argv.slice(2);
const key = readFileSync(join(dir, 'key.pem'));
const cert = readFileSync(join(dir, 'cert.pem'));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sockets = new Set();

function attach(socket, secure, greeting = true) {
  socket.on('error', () => {});
  if (greeting) socket.write('220 localhost Test SMTP server\r\n');
  let buffer = '';
  let data = false;
  const read = (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (data) {
        if (line === '.') {
          data = false;
          emit({ delivered: true, secure });
          socket.write('250 Message accepted\r\n');
        }
        continue;
      }
      const [command, method, credential] = line.split(' ');
      emit({ command });
      if (command === 'EHLO') {
        socket.write(
          `250-localhost\r\n${!secure && mode === 'starttls' ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN\r\n`,
        );
      } else if (command === 'STARTTLS') {
        if (mode !== 'starttls') {
          socket.write('502 STARTTLS unavailable\r\n');
          continue;
        }
        socket.write('220 Begin TLS\r\n');
        socket.removeListener('data', read);
        attach(
          new TLSSocket(socket, {
            isServer: true,
            secureContext: createSecureContext({ key, cert }),
          }),
          true,
          false,
        );
        return;
      } else if (command === 'AUTH' && method === 'PLAIN' && credential) {
        emit({ credential: Buffer.from(credential, 'base64').toString(), secure });
        socket.write('235 Authenticated\r\n');
      } else if (command === 'MAIL' || command === 'RCPT') {
        socket.write('250 OK\r\n');
      } else if (command === 'DATA') {
        data = true;
        socket.write('354 Send message\r\n');
      } else if (command === 'QUIT') {
        socket.end('221 Goodbye\r\n');
      } else {
        socket.write('502 Unsupported command\r\n');
      }
    }
  };
  socket.on('data', read);
}

const server =
  mode === 'tls'
    ? createTlsServer({ key, cert }, (socket) => attach(socket, true))
    : createServer((socket) => attach(socket, false));
server.on('tlsClientError', () => {});
server.on('connection', (socket) => {
  sockets.add(socket);
  emit({ connection: 1 });
  socket.once('close', () => {
    sockets.delete(socket);
    emit({ connection: -1 });
  });
});
server.listen(0, '127.0.0.1', () => emit({ port: server.address().port }));
process.stdin.once('data', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
