import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CloudWorkspaceExecutor, DockerRuntime, LocalExecutor, createExecutor,
  type CommandExecutor,
} from "@repo/adapters";
import {
  cleanupDirectTrust, establishDirectLink, sq, type DirectLink, type ServerConn,
} from "@repo/platform/engine/modules/migration/direct-transfer";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { availablePort, sshReady } from "../helpers/migration-host";

const tag = randomUUID().slice(0, 8);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/migration-target");
const image = `openship-migration-direct:${tag}`;
const networkName = `openship-migration-direct-${tag}`;
const local = new LocalExecutor();

/** Only the provider RPC is simulated: the production Cloud executor frames
 * real commands running in the disposable target VM, including files and SSH.
 * Neither VM mounts the host Docker socket or any host data. */
function providerRuntime(ssh: CommandExecutor) {
  return {
    exec: {
      run: async (args: string[]) => ({ stdout: await ssh.exec(args.map(sq).join(" ")), exit_code: 0 }),
      stream: async function* (args: string[]) {
        const child = await ssh.rawExec!(args.map(sq).join(" "));
        const errors: Buffer[] = [];
        child.stderr.on("data", (bytes: Buffer) => errors.push(bytes));
        for await (const bytes of child.stdout) yield { event: "stdout", data: Buffer.from(bytes).toString("base64") };
        if (errors.length) yield { event: "stderr", data: Buffer.concat(errors).toString("base64") };
        yield { event: "exit", exit_code: await child.onClose };
      },
    },
    files: {
      write: async ({ fullPath, content }: { fullPath: string; content: string }) => {
        await ssh.writeFile(fullPath, content); return { success: true };
      },
      read: async ({ filePath }: { filePath: string }) => ({ success: true, content: await ssh.readFile(filePath) }),
      delete: async ({ path }: { path: string }) => { await ssh.rm(path); return { success: true }; },
    },
  };
}

describeDockerE2E("external SSH to a managed execution endpoint", () => {
  let parent: DockerRuntime;
  let temp: string;
  let source: CommandExecutor;
  let targetSsh: CommandExecutor;
  let target: CloudWorkspaceExecutor;
  let sourceConn: ServerConn;
  let originalKeys: string;
  const containers: string[] = [];
  const connections: CommandExecutor[] = [];
  const runs = new Map<string, DirectLink>();

  beforeAll(async () => {
    await requireDocker();
    parent = await DockerRuntime.create({ transport: "socket" });
    temp = await mkdtemp(join(tmpdir(), "openship-direct-test-"));
    const identity = join(temp, "identity");
    await local.exec(`ssh-keygen -q -t ed25519 -N '' -f ${sq(identity)}`);
    // Preserve a valid last key with NO newline. Appending must not corrupt it.
    originalKeys = (await readFile(`${identity}.pub`, "utf8")).trim();
    await writeFile(`${identity}.pub`, originalKeys);
    await local.exec(`docker build -q -t ${sq(image)} ${sq(fixture)}`, { timeout: 300_000 });
    console.info("[direct-transfer] Isolated Docker/SSH image ready");
    await parent.docker.createNetwork({ Name: networkName, Labels: { "openship.test": tag } });
    const endpoints = [];
    for (const role of ["source", "target"]) {
      const port = await availablePort();
      const vm = await parent.docker.createContainer({
        Image: image, name: `${networkName}-${role}`, Labels: { "openship.test": tag },
        ExposedPorts: { "22/tcp": {} },
        HostConfig: { Privileged: true, NetworkMode: networkName,
          PortBindings: { "22/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } },
      });
      containers.push(vm.id);
      await local.exec(`docker cp ${sq(`${identity}.pub`)} ${sq(`${vm.id}:/root/.ssh/authorized_keys`)}`);
      await vm.start();
      const state = await vm.inspect();
      let ready = false;
      for (let attempt = 0; attempt < 90; attempt++) {
        if (await sshReady(port)) { ready = true; break; }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!ready) throw new Error(`${role} SSH fixture did not start`);
      const executor = createExecutor({ host: "127.0.0.1", port, username: "root", readyTimeoutMs: 5000,
        privateKey: await readFile(identity, "utf8") });
      connections.push(executor);
      await executor.exec("true", { timeout: 5000 });
      console.info(`[direct-transfer] ${role} SSH ready`);
      endpoints.push({ executor, ip: state.NetworkSettings.Networks[networkName]!.IPAddress });
    }
    source = endpoints[0]!.executor;
    targetSsh = endpoints[1]!.executor;
    target = new CloudWorkspaceExecutor(async () => providerRuntime(targetSsh) as never, `test-vm-${tag}`);
    const hostKey = (await source.readFile("/etc/ssh/ssh_host_ed25519_key.pub")).trim().split(/\s+/)[1]!;
    sourceConn = { host: endpoints[0]!.ip, port: 22, user: "root", hostKey };
  }, 300_000);

  async function link() {
    const id = `test-${randomUUID()}`;
    const messages: string[] = [];
    const result = await establishDirectLink({ sourceExec: source, targetExec: target,
      sourceConn, targetConn: null, runId: id, log: message => messages.push(message) });
    if (!result) throw new Error(`No direct link between the fixture servers:\n${messages.join("\n")}`);
    expect(result.direction).toBe("pull");
    runs.set(id, result);
    return { id, link: result };
  }

  afterEach(async () => {
    for (const id of runs.keys()) {
      await cleanupDirectTrust(source, target, id);
      runs.delete(id);
    }
  });
  afterAll(async () => {
    await target?.dispose();
    for (const connection of connections) await connection.dispose();
    for (const id of containers) await parent.docker.getContainer(id).remove({ force: true, v: true });
    await parent?.docker.getNetwork(networkName).remove().catch(() => {});
    await parent?.docker.getImage(image).remove({ force: true }).catch(() => {});
    await parent?.dispose();
    if (temp) await rm(temp, { recursive: true, force: true });
  });

  it("preserves existing keys and concurrent run access, then removes only its own trust", async () => {
    // Prepare utilities once before exercising the concurrent key edits.
    const prepared = await link();
    await cleanupDirectTrust(source, target, prepared.id);
    runs.delete(prepared.id);
    const [first, second] = await Promise.all([link(), link()]);
    const keys = (await source.readFile("/root/.ssh/authorized_keys")).split("\n").filter(Boolean);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(originalKeys);
    expect(keys.some(key => key.endsWith(`openship-migration-${first.id}-pull`))).toBe(true);
    expect(keys.some(key => key.endsWith(`openship-migration-${second.id}-pull`))).toBe(true);
    await cleanupDirectTrust(source, target, first.id);
    runs.delete(first.id);
    const remaining = await source.readFile("/root/.ssh/authorized_keys");
    expect(remaining).toContain(originalKeys);
    expect(remaining).not.toContain(first.id);
    expect(remaining).toContain(second.id);
    await cleanupDirectTrust(source, target, second.id);
    await cleanupDirectTrust(source, target, second.id); // Recovery is idempotent.
    runs.delete(second.id);
    expect((await source.readFile("/root/.ssh/authorized_keys")).trim()).toBe(originalKeys);
    expect(await target.exists(`/tmp/openship-migration-${second.id}-pull`)).toBe(false);
  });

  it("copies named-volume data, directories, empty files and literal special characters", async () => {
    const current = await link();
    await source.exec("docker volume create source-data");
    await target.exec("docker volume create --label openship.project=fixture target-data");
    const srcMount = (await source.exec("docker volume inspect source-data --format '{{.Mountpoint}}'")).trim();
    const dstMount = (await target.exec("docker volume inspect target-data --format '{{.Mountpoint}}'")).trim();
    const literal = "unchanged $TOKEN `command` 'quoted'\nsecond=line";
    await source.writeFile(`${srcMount}/value.txt`, literal);
    await target.writeFile(`${dstMount}/stale.txt`, "old snapshot");
    let progress = 0;
    await current.link.transferVolume("source-data", bytes => { progress = Math.max(progress, bytes); }, "target-data");
    expect(await target.readFile(`${dstMount}/value.txt`)).toBe(literal);
    expect(await target.exists(`${dstMount}/stale.txt`)).toBe(false);
    expect(progress).toBeGreaterThan(0);
    await source.writeFile("/srv/app's settings/empty.conf", "");
    await target.writeFile("/srv/import/sibling.conf", "keep");
    await current.link.transferPath("/srv/app's settings/empty.conf", "/srv/import/empty.conf");
    expect(await target.readFile("/srv/import/empty.conf")).toBe("");
    expect(await target.readFile("/srv/import/sibling.conf")).toBe("keep");
    await current.link.transferPath(srcMount, "/srv/imported-directory");
    expect(await target.readFile("/srv/imported-directory/value.txt")).toBe(literal);
  });

  it("moves a local image through the Cloud command adapter without pulling it on the target", async () => {
    const current = await link();
    await source.exec("docker pull busybox:1.37", { timeout: 120_000 });
    const id = (await source.exec("docker image inspect busybox:1.37 --format '{{.Id}}'")).trim();
    const localTag = `fixture-only:${tag}`;
    await current.link.transferImage({ id, tag: localTag });
    expect((await target.exec(`docker run --rm --pull=never ${sq(localTag)} echo transferred`)).trim()).toBe("transferred");
    await expect(current.link.transferImage({ id: "missing-source-image", tag: `missing:${tag}` })).rejects.toThrow(/image transfer failed/);
  });
});
