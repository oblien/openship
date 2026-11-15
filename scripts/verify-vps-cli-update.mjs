/** Real CLI lifecycle against candidate image digests, on a disposable Linux daemon. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

if (process.env.OPENSHIP_TEST_ISOLATED_VPS !== "1" || process.platform !== "linux")
  throw new Error("Set OPENSHIP_TEST_ISOLATED_VPS=1 only on a disposable Linux VPS/CI runner.");
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = process.env.OPENSHIP_E2E_CLI_ENTRY ?? join(repo, "apps/cli/dist/index.js");
const payload = process.env.OPENSHIP_E2E_CLI_PAYLOAD;
// A private mirror tag avoids depending on publication or a version bump during
// manual candidate builds. The running image IDs must match the supplied digests.
const version = payload
  ? JSON.parse(readFileSync(join(repo, "apps/cli/package.json"), "utf8")).version
  : "candidate";
const baseline = process.env.OPENSHIP_E2E_OLD_VERSION ?? run("git", ["tag", "--merged", "HEAD", "--sort=-version:refname"], { cwd: repo })
  .split("\n").find(tag => /^v\d+\.\d+\.\d+$/.test(tag) && tag !== `v${version}`)?.slice(1);
assert(baseline && /^\d+\.\d+\.\d+$/.test(baseline) && baseline !== version,
  "Supply a distinct published baseline release");
const images = Object.fromEntries(["api", "dashboard", "edge"].map(component => {
  const ref = process.env[`OPENSHIP_E2E_NEW_${component.toUpperCase()}_IMAGE`];
  assert(ref, `Missing candidate ${component} image`);
  return [component, ref];
}));
const root = mkdtempSync(join(tmpdir(), "openship-vps-cli-e2e-"));
const id = `openship-vps-cli-e2e-${process.pid}`;
const registryName = `${id}-registry`;
const releaseName = `${id}-release`;
const caPath = `/usr/local/share/ca-certificates/${id}.crt`;
const homes = [join(root, "upgrade"), join(root, "fresh")];
const admin = { name: "CLI upgrade test", email: "vps-cli-e2e@example.test", password: "CLI-Upgrade-Test-Only!" };
const secretKeys = ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "INTERNAL_TOKEN"];
let registryCertDir;
let registryStarted = false;
let releaseStarted = false;
let originalHosts;
let cert;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8", timeout: 600_000, maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 5).join(" ")} failed: ${result.error?.message ?? ""}\n${(result.stderr ?? "").slice(-5000)}\n${(result.stdout ?? "").slice(-5000)}`);
  return result.stdout.trim();
}
const privileged = (command, args) => process.getuid() === 0 ? run(command, args) : run("sudo", ["-n", command, ...args]);
const docker = (...args) => run("docker", args);
function compose(home, ...args) {
  return docker("compose", "-f", join(home, "compose/docker-compose.yml"), "--env-file", join(home, "compose/.env"), ...args);
}
function envFile(home) {
  return Object.fromEntries(readFileSync(join(home, "compose/.env"), "utf8").split("\n").filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
}
function invoke(entry, home, args) {
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    OPENSHIP_HOME: home, OPENSHIP_ADMIN_PASSWORD: admin.password,
    // Explicit candidate selection, including manual prerelease image workflows.
    ...(payload ? { NODE_EXTRA_CA_CERTS: cert } : { OPENSHIP_VERSION: version }),
  };
  if (payload) delete env.OPENSHIP_VERSION;
  return run(entry.endsWith(".js") ? process.execPath : entry,
    [...(entry.endsWith(".js") ? [entry] : []), ...args], { env });
}
const upArgs = imageVersion => ["up", "--compose", "--yes", "--no-host-control", "--image-version", imageVersion,
  "--port", "14810", "--dashboard-port", "14811", "--public-url", "http://127.0.0.1:14811",
  "--domain-kind", "none", "--admin-name", admin.name, "--admin-email", admin.email];
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve)); return port;
}
async function ready(home) {
  const deadline = Date.now() + 240_000;
  let last;
  while (Date.now() < deadline) {
    try {
      const login = await fetch("http://127.0.0.1:14811/login", { signal: AbortSignal.timeout(3000) });
      const proxy = await fetch("http://127.0.0.1:14811/api/proxy/api/health", { signal: AbortSignal.timeout(3000) });
      const html = await login.text();
      const health = await proxy.text();
      if (login.status === 200 && /<html/i.test(html) && !/<title>[^<]*(?:502|504|Bad Gateway)/i.test(html)
        && proxy.ok && JSON.parse(health).status === "ok") return;
      last = `login=${login.status}, proxy=${proxy.status}`;
    } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`CLI stack not ready: ${last}\n${compose(home, "logs", "--tail", "60", "api")}`);
}
function state(home, service) {
  return JSON.parse(docker("inspect", compose(home, "ps", "-q", service)))[0];
}
function nativeImageId(ref) {
  const image = JSON.parse(docker("image", "inspect", ref))[0];
  // Docker's containerd store can return an OCI index ID for a multi-arch tag,
  // while the container records the selected native manifest ID.
  return /index|manifest\.list/.test(image.Descriptor?.mediaType ?? "")
    ? docker("image", "inspect", "--platform", `${image.Os}/${image.Architecture}`, "--format", "{{.Id}}", ref)
    : image.Id;
}
async function login() {
  const response = await fetch("http://127.0.0.1:14810/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:14811" },
    body: JSON.stringify({ email: admin.email, password: admin.password }), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, "Existing admin must be able to sign in");
  const body = await response.json();
  assert.equal(body.user?.email, admin.email, "Login must authenticate the retained account");
  assert(body.token, "Login must establish a session");
}

try {
  assert.equal(docker("ps", "-aq"), "", "This test requires an empty, disposable Docker daemon");
  if (payload) {
    assert(existsSync(resolve(payload)) && existsSync(`${resolve(payload)}.sha256`), "Missing packaged CLI or checksum");
    for (const path of ["/usr/local/bin/openship", join(homedir(), ".local/bin/openship")]) {
      let existing;
      try { existing = lstatSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
      assert(!existing, `Refusing to replace an existing CLI at ${path}`);
    }
  }
  const port = await freePort();
  const mirror = `127.0.0.1:${port}`;
  registryCertDir = `/etc/docker/certs.d/${mirror}`;
  const certs = join(root, "certs"); mkdirSync(certs);
  cert = join(certs, "ca.crt");
  run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=OpenShip CLI E2E",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:github.com,DNS:api.github.com", "-addext", "basicConstraints=critical,CA:TRUE",
    "-keyout", join(certs, "key.pem"), "-out", join(certs, "ca.crt")]);
  privileged("mkdir", ["-p", registryCertDir]);
  privileged("install", ["-m", "644", join(certs, "ca.crt"), join(registryCertDir, "ca.crt")]);
  privileged("install", ["-m", "644", join(certs, "ca.crt"), caPath]);
  privileged("update-ca-certificates", []);
  docker("run", "-d", "--name", registryName, "-p", `127.0.0.1:${port}:5000`, "-v", `${certs}:/certs:ro`,
    "-e", "REGISTRY_HTTP_TLS_CERTIFICATE=/certs/ca.crt", "-e", "REGISTRY_HTTP_TLS_KEY=/certs/key.pem", "registry:2");
  registryStarted = true;
  run("curl", ["--fail", "--silent", "--show-error", "--retry", "10", "--retry-all-errors", "--retry-delay", "1", "--max-time", "5",
    "--cacert", join(certs, "ca.crt"), `https://${mirror}/v2/`]);
  const expected = {};
  for (const component of ["api", "dashboard", "edge"]) {
    for (const [tag, source] of [[baseline, `ghcr.io/oblien/openship-${component}:${baseline}`], [version, images[component]]]) {
      console.log(`Preparing ${component}:${tag}`);
      docker("pull", source);
      const target = `${mirror}/openship-${component}:${tag}`;
      docker("tag", source, target); docker("push", target);
      if (tag === version) expected[component] = nativeImageId(source);
    }
  }
  for (const [index, home] of homes.entries()) {
    mkdirSync(join(home, "compose"), { recursive: true });
    writeFileSync(join(home, "compose/.env"), `COMPOSE_PROJECT_NAME=${id}-${index}\nOPENSHIP_IMAGE_REGISTRY=${mirror}\n`, { mode: 0o600 });
  }
  const home = homes[0];
  let installed = cli;
  const install = target => {
    run("sh", [join(repo, "scripts/install.sh")], { env: { ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`, OPENSHIP_HOME: target,
      OPENSHIP_VERSION: target === home ? baseline : version,
    } });
    return join(target, "bin/openship");
  };
  if (payload) {
    // Use the released payload and real installer, without adding test URL
    // overrides to the production update command. The only changed DNS is in
    // this disposable Linux host; the candidate uses its normal GitHub URLs.
    const assets = {};
    for (const [tag, source] of [[baseline, null], [version, payload]]) {
      const name = `openship-cli-v${tag}.tar.gz`;
      const path = `/oblien/openship/releases/download/v${tag}/${name}`;
      const local = source ?? process.env.OPENSHIP_E2E_BASELINE_PAYLOAD;
      if (local) {
        copyFileSync(resolve(local), join(root, name)); copyFileSync(`${resolve(local)}.sha256`, join(root, `${name}.sha256`));
      } else {
        for (const suffix of ["", ".sha256"])
          run("curl", ["-fSL", "--connect-timeout", "15", "--max-time", "180", "--retry", "3",
            `https://github.com${path}${suffix}`, "-o", join(root, name + suffix)]);
      }
      for (const suffix of ["", ".sha256"]) assets[path + suffix] = name + suffix;
    }
    writeFileSync(join(root, "release-origin.json"), JSON.stringify({ version, assets }));
    writeFileSync(join(root, "release-state.json"), "{}");
    docker("run", "-d", "--name", releaseName, "-v", `${root}:/fixture:ro`,
      "-v", `${join(repo, "scripts/fixtures/cli-release-server.mjs")}:/server.mjs:ro`, "node:22-alpine", "node", "/server.mjs");
    releaseStarted = true;
    const address = docker("inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", releaseName);
    originalHosts = readFileSync("/etc/hosts");
    writeFileSync(join(root, "hosts"), `${originalHosts}\n${address} github.com api.github.com\n`);
    privileged("cp", [join(root, "hosts"), "/etc/hosts"]);
    run("curl", ["--fail", "--silent", "--retry", "10", "--retry-all-errors", "--retry-delay", "1", "--max-time", "5",
      "--cacert", cert, "https://api.github.com/repos/oblien/openship/releases/latest"]);
    console.log(`Installing the published ${baseline} CLI through scripts/install.sh`);
    installed = install(home);
    assert.equal(invoke(installed, home, ["--version"]), baseline);
  }
  console.log(`Starting the ${baseline} stack`);
  invoke(installed, home, upArgs(baseline));
  await ready(home); await login();
  const before = envFile(home);
  const storage = ["postgres", "redis"].map(service => state(home, service).Id);
  compose(home, "exec", "-T", "redis", "redis-cli", "SET", "cli-upgrade-check", "preserved");
  if (payload) {
    console.log("Verifying checksum rejection leaves the CLI, stack and configuration intact");
    const config = readFileSync(join(home, "compose/.env"), "utf8");
    const active = state(home, "api").Id;
    writeFileSync(join(root, "release-state.json"), JSON.stringify({ badChecksum: true }));
    assert.throws(() => invoke(installed, home, ["--json", "update"]), /checksum mismatch/);
    assert.equal(invoke(installed, home, ["--version"]), baseline);
    assert.equal(state(home, "api").Id, active);
    assert.equal(readFileSync(join(home, "compose/.env"), "utf8"), config);
    writeFileSync(join(root, "release-state.json"), "{}");
  }
  console.log(payload ? "Running plain openship update through the installed launcher" : "Running candidate CLI update reconciliation");
  invoke(installed, home, ["--json", "update", ...(payload ? [] : ["--apply-only"])]);
  if (payload) {
    assert.equal(invoke(installed, home, ["--version"]), version);
    assert.equal(JSON.parse(readFileSync(join(home, "cli-install.json"), "utf8")).tag, `v${version}`);
    assert.equal(readlinkSync(join(home, "cli/current")), `v${version}`);
  }
  await ready(home); await login();
  const after = envFile(home);
  for (const key of secretKeys) {
    const hash = value => createHash("sha256").update(value ?? "").digest("hex");
    assert(before[key], `${key} was not initialized`);
    assert.equal(hash(after[key]), hash(before[key]), `${key} changed on update`);
  }
  for (const key of ["API_PORT", "DASHBOARD_PORT", "OPENSHIP_PUBLIC_URL", "OPENSHIP_HOST_CONTROL"])
    assert.equal(after[key], before[key], `${key} changed on update`);
  assert.equal(after.OPENSHIP_VERSION, version);
  assert.equal(compose(home, "exec", "-T", "redis", "redis-cli", "GET", "cli-upgrade-check"), "preserved");
  for (const [index, service] of ["postgres", "redis"].entries()) assert.equal(state(home, service).Id, storage[index]);
  for (const service of ["api", "dashboard", "edge"]) {
    const current = state(home, service);
    assert.equal(current.Image, expected[service], `${service} is not the candidate image`);
    assert.equal(current.RestartCount, 0, `${service} restarted during update`);
    assert.equal(current.State.Running, true);
  }
  if (payload) {
    console.log("Retrying plain update after the current-version API was stopped");
    compose(home, "stop", "api");
    invoke(installed, home, ["--json", "update"]);
    await ready(home); await login();
  }
  console.log("Checking cold restart and retained login");
  invoke(installed, home, ["stop"]);
  invoke(installed, home, upArgs(version));
  await ready(home); await login();
  compose(home, "down", "-v", "--remove-orphans");
  console.log("Checking fresh candidate install");
  const fresh = payload ? install(homes[1]) : cli;
  invoke(fresh, homes[1], upArgs(version));
  await ready(homes[1]); await login();
  console.log(`PASS: ${payload ? "installed CLI download, checksum verification, re-exec, retry recovery" : "CLI reconciliation"}, cold restart, fresh install, login, dashboard→API proxy, exact images and retained state`);
} catch (error) {
  for (const home of homes) {
    try { console.error(compose(home, "ps", "-a")); console.error(compose(home, "logs", "--tail", "60", "api")); } catch {}
  }
  throw error;
} finally {
  for (const home of homes) { try { compose(home, "down", "-v", "--remove-orphans"); } catch {} }
  if (registryStarted) { try { docker("rm", "-fv", registryName); } catch {} }
  if (originalHosts) {
    writeFileSync(join(root, "hosts"), originalHosts);
    privileged("cp", [join(root, "hosts"), "/etc/hosts"]);
  }
  if (releaseStarted) { try { docker("rm", "-fv", releaseName); } catch {} }
  if (payload) for (const path of ["/usr/local/bin/openship", join(homedir(), ".local/bin/openship")]) {
    try {
      if (lstatSync(path).isSymbolicLink() && homes.some(home => readlinkSync(path) === join(home, "bin/openship"))) privileged("rm", ["-f", path]);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (registryCertDir) { try { privileged("rm", ["-rf", registryCertDir]); } catch {} }
  try { privileged("rm", ["-f", caPath]); privileged("update-ca-certificates", []); } catch {}
  rmSync(root, { recursive: true, force: true });
}
