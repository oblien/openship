import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { createServer as createTlsServer, createSecureContext, TLSSocket } from "node:tls";

const [mode, reply, dir, commandLogDelayMs = "0"] = process.argv.slice(2);
const key = readFileSync(join(dir, "key.pem"));
const cert = readFileSync(join(dir, "cert.pem"));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sockets = new Set();

function attach(socket, secure, greeting = true) {
  socket.on("error", () => {});
  if (greeting) socket.write("* OK Test IMAP server\r\n");
  let buffer = "";
  let authTag = "";
  const authenticate = (tag, payload) => {
    emit({ credential: Buffer.from(payload, "base64").toString() });
    if (reply === "disconnect") {
      socket.destroy();
      return;
    }
    socket.write(
      reply === "success"
        ? `${tag} OK Authenticated\r\n`
        : `${tag} NO [${reply}] ${reply === "AUTHENTICATIONFAILED" ? "Authentication failed" : "Authentication backend unavailable"}\r\n`,
    );
  };
  const read = (chunk) => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (authTag) {
        const tag = authTag;
        authTag = "";
        authenticate(tag, line);
        continue;
      }
      const [tag, command, , initial] = line.split(" ");
      // The socket response and stdout telemetry are independent transports.
      // Allow tests to reproduce a final command receipt arriving after logout.
      if (command === "LOGOUT" && Number(commandLogDelayMs) > 0)
        setTimeout(() => emit({ command }), Number(commandLogDelayMs));
      else emit({ command });
      if (command === "STARTTLS") {
        socket.write(`${tag} OK Start TLS\r\n`);
        socket.removeListener("data", read);
        attach(
          new TLSSocket(socket, {
            isServer: true,
            secureContext: createSecureContext({ key, cert }),
          }),
          true,
          false,
        );
        return;
      }
      if (command === "AUTHENTICATE") {
        if (initial) authenticate(tag, initial);
        else {
          authTag = tag;
          socket.write("+ \r\n");
        }
        continue;
      }
      if (command === "CAPABILITY")
        socket.write(
          `* CAPABILITY IMAP4rev1 AUTH=PLAIN${!secure && mode === "starttls" ? " STARTTLS" : ""}\r\n`,
        );
      if (command === "LIST") socket.write('* LIST (\\Noselect) "/" ""\r\n');
      if (command === "SELECT")
        socket.write(
          "* 1 EXISTS\r\n* OK [UIDVALIDITY 1] Valid\r\n* OK [UIDNEXT 2] Next\r\n* FLAGS (\\Seen)\r\n",
        );
      if (command === "LOGOUT") socket.write("* BYE Logged out\r\n");
      socket.write(`${tag} OK Completed\r\n`);
      if (command === "LOGOUT") socket.end();
    }
  };
  socket.on("data", read);
}

const server =
  mode === "tls"
    ? createTlsServer({ key, cert }, (socket) => attach(socket, true))
    : createServer((socket) => attach(socket, false));
server.on("tlsClientError", () => {});
server.on("connection", (socket) => {
  sockets.add(socket);
  emit({ connection: 1 });
  socket.once("close", () => {
    sockets.delete(socket);
    emit({ connection: -1 });
  });
});
server.listen(0, "127.0.0.1", () => emit({ port: server.address().port }));
process.stdin.once("data", () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
