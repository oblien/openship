// Disposable counting origin. Launched only inside the fixture's owned container.
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [port, events, deps] = process.argv.slice(2);
const require = createRequire(join(deps!, "package.json"));
const { Server } = require("socket.io");
const record = (event: Record<string, unknown>) =>
  appendFileSync(events!, JSON.stringify({ time: new Date().toISOString(), ...event }) + "\n");
const server = createServer((req, res) => {
  if (req.url?.startsWith("/socket.io/")) return;
  let bytes = 0;
  req.on("data", (data) => (bytes += data.length));
  req.on("end", () => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ bytes, host: req.headers.host }));
  });
});
const io = new Server(server, { maxHttpBufferSize: 2 * 1024 * 1024 });
server.prependListener("request", (req) => {
  const id =
    req.headers["x-fixture-id"] ?? new URL(req.url!, "http://fixture").searchParams.get("proofId");
  record({ event: "http-start", id, method: req.method, url: req.url, host: req.headers.host });
  let bytes = 0;
  // Engine.IO installs its reader after middleware. A data observer here could
  // start flowing too early and steal its body. Start counters prove rejection;
  // only ordinary /count requests need an independent measured byte total.
  const polling = req.url?.startsWith("/socket.io/");
  if (!polling) req.on("data", (data) => (bytes += data.length));
  req.on("end", () =>
    record({ event: "http-end", id, bytes: polling ? null : bytes, method: req.method }),
  );
});
server.on("upgrade", (req) => record({ event: "upgrade", url: req.url, host: req.headers.host }));
io.on("connection", (socket: any) => {
  socket.on("proof", (payload: { id: string; data: string }, ack: (value: unknown) => void) => {
    const bytes = Buffer.byteLength(payload.data);
    record({
      event: "socket-message",
      id: payload.id,
      bytes,
      transport: socket.conn.transport.name,
    });
    ack({ bytes });
  });
  socket.on("disconnect", (reason: string) => record({ event: "socket-disconnect", reason }));
});
server.listen(Number(port), "127.0.0.1", () =>
  record({ event: "ready", port: Number(port), appMessageLimit: 2 * 1024 * 1024 }),
);
