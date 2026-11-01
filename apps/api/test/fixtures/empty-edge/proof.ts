import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { LocalExecutor } from "../../../../../packages/adapters/src/system/local-executor";
import { scanOpenshipEdgeStrict } from "../../../../../packages/adapters/src/system/proxy/import/nginx";

const executor = new LocalExecutor();
const cases: string[] = [];
async function empty() {
  assert.equal((await scanOpenshipEdgeStrict(executor)).loopbackUpstreamPorts.size, 0);
}
async function reject(name: string) {
  await assert.rejects(scanOpenshipEdgeStrict(executor), /Cannot read Openship edge routes/);
  cases.push(name);
}
if (process.argv[2] === "unprivileged") {
  // Verify this exercises unreadable host files, rather than accidentally
  // passing because the unprivileged process cannot reach Docker at all.
  const daemon = spawnSync("docker", ["info"], { encoding: "utf8" });
  assert.equal(daemon.status, 0, daemon.stderr);
  await assert.rejects(scanOpenshipEdgeStrict(executor), /Cannot read Openship edge routes/);
  process.exit(0);
}
await empty();
cases.push("fresh private host needs no edge installation");
const listener = createServer();
await new Promise<void>((resolve) => listener.listen(80, "0.0.0.0", resolve));
try { await reject("active listener is protected"); }
finally { await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); }
await empty();
await mkdir("/etc/nginx/conf.d", { recursive: true });
await writeFile("/etc/nginx/conf.d/stale.conf", "server { listen 80; location / { proxy_pass http://127.0.0.1:20000; } }");
try { await reject("dormant host proxy configuration is protected"); }
finally { await rm("/etc/nginx", { recursive: true }); }
await empty();
const imported = spawnSync("docker", ["import", "-", "empty-ingress-proof:local"], { input: Buffer.alloc(10_240), encoding: "utf8" });
assert.equal(imported.status, 0, imported.stderr);
try {
  await executor.exec("docker create --name dormant-ingress -p 127.0.0.1:80:8080 empty-ingress-proof:local /bin/true");
  try { await reject("stopped Docker ingress declaration is protected"); }
  finally { await executor.exec("docker rm dormant-ingress"); }
  await empty();
  await executor.exec("docker create --name dormant-host-network --network host empty-ingress-proof:local /bin/true");
  try { await reject("dormant host-network container is protected"); }
  finally { await executor.exec("docker rm dormant-host-network"); }
  await empty();
} finally { await executor.exec("docker image rm empty-ingress-proof:local"); }
await writeFile("/usr/local/bin/caddy", "#!/bin/sh\nexit 0\n", { mode: 0o755 });
try { await reject("installed dormant proxy is protected"); }
finally { await rm("/usr/local/bin/caddy"); }
await empty();
process.env.DOCKER_HOST = "unix:///missing-ingress-proof.sock";
try { await reject("unreadable Docker inventory fails closed"); }
finally { delete process.env.DOCKER_HOST; }
await empty();
await mkdir("/var/lib/openship/edge/sites-enabled", { recursive: true });
await writeFile("/var/lib/openship/edge/sites-enabled/hidden.conf", "server { listen 80; }");
await chmod("/var/lib/openship", 0o700);
try {
  const socket = await stat("/var/run/docker.sock");
  const child = spawnSync(process.execPath, [process.argv[1]!, "unprivileged"], {
    uid: 65534, gid: socket.gid, encoding: "utf8",
    env: { ...process.env, DOCKER_CONFIG: "/tmp" },
  });
  assert.equal(child.status, 0, child.stderr);
  cases.push("filesystem permission blindness fails closed");
} finally { await rm("/var/lib/openship", { recursive: true }); }
await empty();
console.log(JSON.stringify({ passed: cases }));
