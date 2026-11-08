// Isolated release origin for the real, unmodified installed updater. Only the
// disposable runner maps github.com/api.github.com to this container's address.
import { createServer } from "node:https";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { pipeline } from "node:stream";

const config = JSON.parse(readFileSync("/fixture/release-origin.json", "utf8"));
const server = createServer({
  key: readFileSync("/fixture/certs/key.pem"),
  cert: readFileSync("/fixture/certs/ca.crt"),
}, (request, response) => {
  const state = JSON.parse(readFileSync("/fixture/release-state.json", "utf8"));
  const path = new URL(request.url, "https://github.com").pathname;
  if (path === "/repos/oblien/openship/releases/latest") {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ tag_name: `v${config.version}` }));
    return;
  }
  const asset = config.assets[path];
  if (!asset) { response.writeHead(404); response.end(); return; }
  if (state.badChecksum && asset.endsWith(".sha256")) {
    response.end("0".repeat(64)); return;
  }
  const file = `/fixture/${asset}`;
  response.setHeader("content-length", statSync(file).size);
  pipeline(createReadStream(file), response, error => {
    if (error) process.stderr.write(`Release response interrupted: ${error.message}\n`);
  });
});
server.keepAliveTimeout = 120_000;
server.listen(443, "0.0.0.0");
