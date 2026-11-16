import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
import { createServer } from "node:net";

const exec = promisify(execFile);
const root = resolve(import.meta.dir, "..");
const state = join(root, ".dev-mail");
const certs = join(state, "certs");
const command = process.argv.slice(2).filter((arg) => arg !== "--")[0] ?? "up";
if (!["up", "down", "reset", "check"].includes(command)) {
  throw new Error("Usage: bun dev:email:sample [up|down|reset|check]");
}

async function exists(path: string) {
  return access(path).then(
    () => true,
    () => false,
  );
}

async function localDockerContext() {
  const saved = await readFile(join(state, "docker-context"), "utf8").catch(() => "");
  const preferred =
    process.env.DOCKER_CONTEXT ||
    saved.trim() ||
    (await exec("docker", ["context", "show"])).stdout.trim();
  const available = async (context: string) => {
    try {
      const { stdout } = await exec("docker", [
        "context",
        "inspect",
        context,
        "--format",
        "{{.Endpoints.docker.Host}}",
      ]);
      if (!/^(unix|npipe):\/\//.test(stdout.trim())) return false;
      await exec("docker", ["--context", context, "info", "--format", "{{.ServerVersion}}"], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  };
  if (await available(preferred)) return preferred;
  if (process.env.DOCKER_CONTEXT || saved.trim()) {
    throw new Error(
      `Start the local Docker engine for ${preferred}, or select another with DOCKER_CONTEXT.`,
    );
  }
  const { stdout } = await exec("docker", ["context", "ls", "--format", "{{.Name}}"]);
  const local: string[] = [];
  for (const context of stdout.trim().split("\n")) {
    if (context !== preferred && (await available(context))) local.push(context);
  }
  if (local.length !== 1)
    throw new Error(
      "Start Docker Desktop or Colima, then select its local engine with DOCKER_CONTEXT.",
    );
  return local[0]!;
}

await mkdir(certs, { recursive: true });
const context = await localDockerContext();
await writeFile(join(state, "docker-context"), `${context}\n`);
const compose = ["--context", context, "compose", "-f", join(import.meta.dir, "compose.yml")];
async function docker(args: string[]) {
  const child = spawn("docker", [...compose, ...args], { cwd: root, stdio: "inherit" });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error(`Sample mail Docker command failed (${code}).`);
}

async function stopAssistants(remove = false) {
  const { stdout } = await exec("docker", [
    "--context",
    context,
    "ps",
    "-aq",
    "--filter",
    "label=io.openship.mail.assistant",
    "--filter",
    "network=openship-mail-sample_default",
  ]);
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length)
    await exec("docker", ["--context", context, ...(remove ? ["rm", "-f"] : ["stop"]), ...ids]);
}

if (command === "down") {
  await stopAssistants();
  await docker(["down"]);
  process.exit(0);
}
if (command === "check") {
  await docker(["exec", "-T", "api", "bun", "test/sample-mail-cycle.ts"]);
  process.exit(0);
}

// Catch an existing session before starting or resetting its backend.
await new Promise<void>((resolve, reject) => {
  const server = createServer();
  server.once("error", () =>
    reject(new Error("Port 3040 is in use. Stop the existing sample dev command first.")),
  );
  server.listen(3040, "127.0.0.1", () => server.close(() => resolve()));
});

if (!(await exists(join(state, "server.env")))) {
  await writeFile(
    join(state, "server.env"),
    `SESSION_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}\nBRANDING_ADMIN_TOKEN=${randomBytes(32).toString("hex")}\n`,
    { mode: 0o600 },
  );
}
const certificateCurrent = await exec("openssl", [
  "x509",
  "-in",
  join(certs, "ca.crt"),
  "-noout",
  "-checkend",
  "86400",
]).then(
  () => true,
  () => false,
);
const renewCertificate = !certificateCurrent || !(await exists(join(certs, "mail.p12")));
if (renewCertificate) {
  // A private test CA is trusted only by the sample API process. Never disable TLS checks.
  const config = join(certs, "openssl.cnf");
  await writeFile(
    config,
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=cert\n[dn]\nCN=mail\n[cert]\nsubjectAltName=DNS:mail,DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
  );
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "30",
    "-config",
    config,
    "-keyout",
    join(certs, "key.pem"),
    "-out",
    join(certs, "ca.crt"),
  ]);
  await exec("openssl", [
    "pkcs12",
    "-export",
    "-inkey",
    join(certs, "key.pem"),
    "-in",
    join(certs, "ca.crt"),
    "-out",
    join(certs, "mail.p12"),
    "-passout",
    "pass:sample-only",
  ]);
}

if (command === "reset") {
  await stopAssistants(true);
  await docker(["down", "--volumes"]);
}
console.log(`[sample mail] Using local Docker context ${context}`);
await docker([
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "240",
  ...(renewCertificate ? ["--force-recreate"] : []),
]);
console.log(
  "\nOpen http://127.0.0.1:3040\nAccounts: alex@openship.test / sam@openship.test\nPassword for both: sample-mail\nMail stays inside this sample environment.\n",
);

const client = spawn(
  process.execPath,
  ["run", "dev", "--host", "127.0.0.1", "--port", "3040", "--strictPort"],
  {
    cwd: join(root, "client"),
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development", MAIL_DEV_API_URL: "http://127.0.0.1:3041" },
  },
);
// Keep Compose running between frontend restarts; `down` explicitly stops it.
process.exitCode = await new Promise<number>((resolve, reject) => {
  client.once("error", reject);
  client.once("exit", (code) => resolve(code ?? 1));
});
