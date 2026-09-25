import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Server, utils, type Connection } from "ssh2";
import { buildCloudflareProxyCommand, resolveCloudflaredExecutable } from "./cloudflare-ssh";
import { createExecutor } from "./executor";
import { buildRsyncSshCommand } from "./remote-transfer";
import type { CommandExecutor } from "../types";

afterEach(() => vi.unstubAllEnvs());

describe("Cloudflare executable policy", () => {
  it("resolves the bundled Windows client without splitting paths containing spaces", () => {
    const path = "C:\\Program Files (x86)\\OpenShip\\cloudflared.exe";
    const options = { platform: "win32" as const, env: { OPENSHIP_CLOUDFLARED_PATH: path }, isFile: (p: string) => p === path };
    expect(resolveCloudflaredExecutable(options)).toBe(path);
    expect(buildCloudflareProxyCommand("ssh.example.com", options)).toBe('"C:/Program Files (x86)/OpenShip/cloudflared.exe" access ssh --hostname ssh.example.com');
  });
  it("uses case-insensitive Windows Path and never searches the current directory", () => {
    const path = "C:\\Tools\\cloudflared.exe";
    const isFile = vi.fn((p: string) => p === path);
    expect(resolveCloudflaredExecutable({ platform: "win32", env: { Path: ";.;C:\\Tools" }, isFile })).toBe(path);
    expect(isFile).toHaveBeenCalledExactlyOnceWith(path);
  });
  it("fails with an installation remedy instead of falling back to direct SSH", () => {
    expect(() => resolveCloudflaredExecutable({ env: { PATH: ".:" }, platform: "linux", isFile: () => true })).toThrow(/Install it/);
    expect(() => resolveCloudflaredExecutable({ env: { OPENSHIP_CLOUDFLARED_PATH: "./cloudflared" }, isFile: () => true })).toThrow(/installed/);
  });
  it.each(["C:\\Users\\%USERNAME%\\cloudflared.exe", "C:\\Tools\\bad\"path\\cloudflared.exe", "C:\\Tools\\bad!path\\cloudflared.exe"])("refuses executable path expansion: %s", path => {
    expect(() => buildCloudflareProxyCommand("ssh.example.com", { platform: "win32", env: { OPENSHIP_CLOUDFLARED_PATH: path }, isFile: () => true })).toThrow(/path/);
  });
});

// An actual SSH handshake through a disposable subprocess byte proxy. No real
// Cloudflare account/host is needed, and ssh.example.test cannot be dialed directly.
describe.skipIf(process.platform === "win32")("Cloudflare SSH transport lifecycle", () => {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const userKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const encryptedKey = userKey.export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "key-passphrase" }).toString();
  const parsedKey = utils.parseKey(userKey.export({ type: "pkcs1", format: "pem" }).toString());
  if (parsedKey instanceof Error || Array.isArray(parsedKey)) throw new Error("Invalid fixture key");
  let dir: string;
  let server: Server;
  let executor: CommandExecutor | undefined;
  const connections = new Set<Connection>();
  let handshakes = 0;

  beforeEach(async () => {
    handshakes = 0;
    dir = mkdtempSync(join(tmpdir(), "openship cloudflare test "));
    server = new Server({ hostKeys: [hostKey] }, client => {
      connections.add(client);
      client.on("error", () => {});
      client.on("close", () => connections.delete(client));
      client.on("authentication", ctx => {
        if (ctx.method === "password" && ctx.password === "ssh-password") return ctx.accept();
        if (ctx.method === "publickey" && ctx.key.data.equals(parsedKey.getPublicSSH()) &&
          (!ctx.signature || parsedKey.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)) return ctx.accept();
        ctx.reject();
      });
      client.on("ready", () => {
        handshakes++;
        client.on("session", accept => {
          const session = accept();
          session.on("exec", (accept, _reject, info) => {
            const channel = accept();
            if (info.command === "docker system dial-stdio") {
              channel.once("data", () => channel.end("HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nOK"));
            } else {
              channel.write("exec-ok\n"); channel.exit(0); channel.end();
            }
          });
          session.on("pty", accept => accept?.());
          session.on("shell", accept => {
            const channel = accept();
            channel.on("data", (data: Buffer) => channel.write(data));
            channel.on("end", () => channel.end());
          });
        });
        client.on("tcpip", accept => {
          const channel = accept();
          channel.on("data", (data: Buffer) => channel.write(data));
          channel.on("end", () => channel.end());
        });
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const binary = join(dir, "cloudflared");
    writeFileSync(binary, `#!${process.execPath}\nconst net = require('node:net');\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['access', 'ssh', '--hostname', 'ssh.example.test'])) process.exit(4);\nconst socket = net.connect(${port}, '127.0.0.1');\nprocess.stdin.pipe(socket).pipe(process.stdout);\nsocket.on('error', () => process.exit(5));\nsocket.on('close', () => process.exit(0));\n`, { mode: 0o700 });
    vi.stubEnv("OPENSHIP_CLOUDFLARED_PATH", binary);
  });
  afterEach(async () => {
    await executor?.dispose?.();
    executor = undefined;
    for (const connection of connections) connection.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["password", "encrypted key"])("reuses one proxied SSH connection for commands, Docker, terminal and forwarding with %s", async auth => {
    executor = createExecutor({ host: "ssh.example.test", sshTransport: "cloudflare", ...(auth === "password" ? { password: "ssh-password" } : { privateKey: encryptedKey, privateKeyPassphrase: "key-passphrase" }) });
    expect(await executor.exec("printf exec-ok")).toBe("exec-ok");
    const docker = await executor.openDockerDialStdio!();
    const reply = once(docker, "data");
    docker.write("GET /_ping HTTP/1.0\r\n\r\n");
    expect((await reply)[0].toString()).toContain("200 OK");
    docker.destroy();
    const shell = await executor.openShell!();
    const echo = once(shell.stdout, "data");
    shell.stdin.write("terminal\n");
    expect((await echo)[0].toString()).toBe("terminal\n");
    shell.close();
    const tunnel = await executor.forwardPort!("127.0.0.1", 6379);
    const forwarded = once(tunnel, "data");
    tunnel.write("private-service");
    expect((await forwarded)[0].toString()).toBe("private-service");
    tunnel.destroy();
    expect(handshakes).toBe(1);
  });

  it("cleans up the proxy after rejected SSH authentication", async () => {
    executor = createExecutor({ host: "ssh.example.test", sshTransport: "cloudflare", password: "wrong" });
    await expect(executor.exec("true")).rejects.toThrow(/authentication/i);
    await vi.waitFor(() => expect(connections.size).toBe(0));
  });

  it("reports the Access failure without asking the user to expose the public SSH port", async () => {
    writeFileSync(join(dir, "cloudflared"), `#!${process.execPath}\nprocess.stderr.write('Access policy denied this account\\n');\nprocess.exitCode = 1;\n`, { mode: 0o700 });
    executor = createExecutor({ host: "ssh.example.test", sshTransport: "cloudflare", password: "ssh-password" });
    const attempt = executor.exec("true");
    await expect(attempt).rejects.toThrow(/Cloudflare Access/);
    await expect(attempt).rejects.toThrow(/Access policy denied this account/);
    await expect(attempt).rejects.not.toThrow(/port 22 is open/);
  });

  it.skipIf(!(() => { try { execFileSync("/usr/bin/ssh", ["-V"], { stdio: "ignore" }); return true; } catch { return false; } })())("runs real OpenSSH commands and Docker over the generated proxy", async () => {
    const keyPath = join(dir, "agent-test-key");
    writeFileSync(keyPath, userKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
    // Isolate the test from the operator's config, keys and known_hosts. The
    // wrapper adds fixture-only settings before delegating to real OpenSSH.
    // OpenSSH parses this option as a list even when passed as one argv entry.
    const isolatedArgs = ["-F", "/dev/null", "-o", `UserKnownHostsFile="${join(dir, "known_hosts")}"`, "-o", "IdentitiesOnly=yes", "-i", keyPath];
    writeFileSync(join(dir, "ssh"), `#!${process.execPath}\nconst child = require('node:child_process').spawn('/usr/bin/ssh', [...${JSON.stringify(isolatedArgs)}, ...process.argv.slice(2)], { stdio: 'inherit' });\nchild.on('error', () => process.exit(1));\nchild.on('exit', code => process.exit(code || 0));\n`, { mode: 0o700 });
    vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
    executor = createExecutor({ host: "ssh.example.test", sshTransport: "cloudflare", useSystemSsh: true });
    expect(await executor.exec("echo ok")).toBe("exec-ok");
    expect(readFileSync(join(dir, "known_hosts"), "utf8").trim()).not.toBe("");
    const docker = await executor.openDockerDialStdio!();
    const response = once(docker, "data");
    docker.write("GET /_ping HTTP/1.0\r\n\r\n");
    expect((await response)[0].toString()).toContain("200 OK");
    docker.destroy();
    expect(handshakes).toBe(1);
  });

  it("gives rsync the same generated proxy instead of connecting to public port 22", () => {
    const command = buildRsyncSshCommand({ host: "ssh.example.test", sshTransport: "cloudflare", sshAgent: "/tmp/test-agent" });
    expect(command).toContain("ProxyCommand=");
    expect(command).toContain("access ssh --hostname ssh.example.test");
    expect(command).toContain(dir);
  });

  it.skipIf(!(() => { try { execFileSync("rsync", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })())("preserves the generated ProxyCommand through rsync's actual argument parser", () => {
    const record = join(dir, "ssh-arguments.json");
    writeFileSync(join(dir, "ssh"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(1);\n`, { mode: 0o700 });
    const source = join(dir, "source.txt");
    writeFileSync(source, "source");
    const config = { host: "ssh.example.test", sshTransport: "cloudflare" as const };
    try {
      execFileSync("rsync", ["--dry-run", "-e", buildRsyncSshCommand(config), source, "root@ssh.example.test:/tmp/source.txt"], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdio: "ignore", timeout: 5000,
      });
    } catch { /* fixture records argv and intentionally exits before transferring */ }
    const args = JSON.parse(readFileSync(record, "utf8"));
    expect(args).toContain(`ProxyCommand=${buildCloudflareProxyCommand(config.host)}`);
  });
});
