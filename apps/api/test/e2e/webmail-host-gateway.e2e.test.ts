import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import Dockerode from "dockerode";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DockerRuntime } from "@repo/adapters";
import { withTimeout } from "@repo/core";
import { describeDockerE2E, dockerSocketPath, requireDocker } from "../helpers/docker-e2e";

const exec = promisify(execFile);
const slug = `webmail-host-${randomUUID().slice(0, 8)}`;
const host = "mail.openship.test";
const image = "node:22-bookworm-slim";
const docker = new Dockerode({ socketPath: dockerSocketPath });
let runtime: DockerRuntime;
let group: { id: string };
let directory: string;
let certificate: string;
let port: number;
let backend: Dockerode.Container;
const clients: string[] = [];

async function logs(container: Dockerode.Container): Promise<string> {
  return (await container.logs({ stdout: true, stderr: false, follow: false })).toString();
}

// The backend runs on the disposable Linux Docker host. The client is created
// by the production runtime on its own bridge. A loopback DNS answer reproduces
// the failure; host-gateway must fix it while TLS still verifies the mail name.
describeDockerE2E("webmail hostname on the mail server's Docker host", () => {
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(image);
    directory = await mkdtemp(join(tmpdir(), "openship-webmail-host-"));
    await writeFile(
      join(directory, "openssl.cnf"),
      `[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=cert\n[dn]\nCN=${host}\n[cert]\nsubjectAltName=DNS:${host}\nbasicConstraints=critical,CA:TRUE\n`,
    );
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      join(directory, "openssl.cnf"),
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
    ]);
    certificate = (await readFile(join(directory, "cert.pem"))).toString("base64");
    const key = (await readFile(join(directory, "key.pem"))).toString("base64");
    backend = await docker.createContainer({
      name: `${slug}-backend`,
      Image: image,
      Env: [`TEST_CERT=${certificate}`, `TEST_KEY=${key}`],
      Cmd: [
        "node",
        "-e",
        `const tls=require('node:tls');const server=tls.createServer({cert:Buffer.from(process.env.TEST_CERT,'base64'),key:Buffer.from(process.env.TEST_KEY,'base64')},socket=>socket.end('* OK fixture ready\\r\\n'));server.on('tlsClientError',()=>{});server.listen(0,'0.0.0.0',()=>console.log(JSON.stringify({port:server.address().port})));`,
      ],
      HostConfig: { NetworkMode: "host" },
      Labels: { "openship.e2e": slug },
    });
    await backend.start();
    for (let attempt = 0; attempt < 50; attempt++) {
      const found = /\{"port":(\d+)\}/.exec(await logs(backend));
      if (found) {
        port = Number(found[1]);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(port).toBeGreaterThan(0);
    group = await runtime.ensureServiceGroup({ projectId: slug, deploymentId: slug, slug });
  }, 120_000);

  afterAll(async () => {
    for (const id of clients)
      await docker
        .getContainer(id)
        .remove({ force: true })
        .catch(() => {});
    await backend?.remove({ force: true }).catch(() => {});
    if (group)
      await docker
        .getNetwork(group.id)
        .remove()
        .catch(() => {});
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function probe(address: string, servername = host) {
    const code = `const tls=require('node:tls'),dns=require('node:dns').promises; (async()=>{const answer=await dns.lookup(process.env.TEST_HOST);const result=await new Promise(resolve=>{const socket=tls.connect({host:process.env.TEST_HOST,port:Number(process.env.TEST_PORT),servername:process.env.TEST_SERVERNAME,ca:Buffer.from(process.env.TEST_CERT,'base64'),rejectUnauthorized:true});socket.setTimeout(4000);socket.once('secureConnect',()=>{resolve({trusted:socket.authorized});socket.destroy();});socket.once('timeout',()=>{resolve({error:'TIMEOUT'});socket.destroy();});socket.once('error',error=>resolve({error:error.code}));});console.log(JSON.stringify({address:answer.address,...result}));})();`;
    const result = await runtime.deployServiceWorkload(group, {
      projectId: slug,
      deploymentId: slug,
      slug,
      serviceName: "webmail",
      image,
      imageAlreadyPrepared: true,
      ports: [],
      volumes: [],
      namespaceVolumes: true,
      environment: {
        TEST_HOST: host,
        TEST_SERVERNAME: servername,
        TEST_PORT: String(port),
        TEST_CERT: certificate,
      },
      commandArgv: ["node", "-e", code],
      restart: "no",
      advanced: { extraHosts: { [host]: address } },
    });
    clients.push(result.containerId);
    const container = docker.getContainer(result.containerId);
    expect(
      (await withTimeout(container.wait(), 10_000, "TLS client did not finish")).StatusCode,
    ).toBe(0);
    const output = await logs(container);
    const found = output.slice(output.indexOf("{")).trim();
    return JSON.parse(found) as { address: string; trusted?: boolean; error?: string };
  }

  it("repairs a loopback backend on redeploy and preserves certificate verification", async () => {
    expect(await probe("127.0.1.1")).toEqual({ address: "127.0.1.1", error: "ECONNREFUSED" });
    const fixed = await probe("host-gateway");
    expect(fixed.address).not.toBe("127.0.1.1");
    expect(fixed.trusted).toBe(true);
    expect((await probe("host-gateway", "wrong.openship.test")).error).toBe(
      "ERR_TLS_CERT_ALTNAME_INVALID",
    );
    expect((await probe("host-gateway")).trusted).toBe(true);
  }, 30_000);
});
