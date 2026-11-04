import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Dockerode from "dockerode";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { parse } from "yaml";
import {
  createKubernetesApi,
  type KubernetesApi,
  type KubernetesObject,
} from "../src/cluster/kubernetes-api";
import { admitProjectManifests, applyProjectManifests } from "../src/cluster/project-manifests";
import { splitDockerFrames } from "../src/runtime/docker";

// Real API validation and controllers, with no worker nodes or external services.
// No kubeconfig, provider credentials, published app ports or user cluster is used.
const IMAGE =
  "rancher/k3s:v1.34.1-k3s1@sha256:5e0707cfd1239b358ef73f3254bc3eadc027dd30cd5ec6ca41e29e47652a1b8c";
const owner = { projectId: "manifest-e2e", runtimeId: "test-runtime", namespace: "manifest-e2e" };

describe.runIf(process.env.RUN_KUBERNETES_E2E === "1")("project manifests against K3s", () => {
  let container: Dockerode.Container | undefined;
  let api: KubernetesApi | undefined;
  const live = () => {
    if (!api) throw new Error("Kubernetes fixture is not ready");
    return api;
  };
  const apply = (objects: KubernetesObject[]) =>
    applyProjectManifests(live(), admitProjectManifests(objects, owner), owner);
  const config = (value: string) => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "settings" },
    data: { value },
  });
  const deployment = (image = "busybox:1.37-musl", app = "example") => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web" },
    spec: {
      replicas: 0,
      selector: { matchLabels: { app } },
      template: {
        metadata: { labels: { app } },
        spec: { containers: [{ name: "web", image, command: ["sleep", "3600"] }] },
      },
    },
  });
  const job = (image = "busybox:1.37-musl") => ({
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: "task" },
    spec: {
      suspend: true,
      template: {
        metadata: { labels: { app: "task" } },
        spec: {
          restartPolicy: "Never",
          containers: [{ name: "task", image, command: ["true"] }],
        },
      },
    },
  });

  beforeAll(async () => {
    const docker = new Dockerode({
      socketPath: process.env.DOCKER_HOST?.replace(/^unix:\/\//, "") ?? "/var/run/docker.sock",
    });
    await docker.ping(); // Opt-in CI must fail when Docker is missing.
    try {
      await docker.getImage(IMAGE).inspect();
    } catch {
      const stream = await docker.pull(IMAGE);
      await new Promise<void>((resolve, reject) =>
        docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve())),
      );
    }
    container = await docker.createContainer({
      Image: IMAGE,
      Cmd: [
        "server",
        "--disable-agent",
        "--disable=traefik,servicelb,metrics-server,local-storage,coredns",
        "--disable-network-policy",
        "--flannel-backend=none",
        "--tls-san=127.0.0.1",
      ],
      ExposedPorts: { "6443/tcp": {} },
      Labels: { "openship.test": "project-manifests" },
      HostConfig: {
        Privileged: true,
        PortBindings: { "6443/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
      },
    });
    await container.start();
    const info = await container.inspect();
    const port = Number(info.NetworkSettings.Ports["6443/tcp"]![0]!.HostPort);
    const deadline = Date.now() + 90_000;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        if (!api) {
          const exec = await container.exec({
            Cmd: ["cat", "/etc/rancher/k3s/k3s.yaml"],
            AttachStdout: true,
            AttachStderr: true,
          });
          const stream = await exec.start({ hijack: true, stdin: false });
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          if ((await exec.inspect()).ExitCode !== 0) throw new Error("Waiting for K3s credentials");
          const config = parse(
            splitDockerFrames(Buffer.concat(chunks))
              .filter((frame) => frame.stdout)
              .map((frame) => frame.data.toString())
              .join(""),
          );
          const pem = (encoded: string) => Buffer.from(encoded, "base64").toString();
          api = createKubernetesApi({
            host: "127.0.0.1",
            ca: pem(config.clusters[0].cluster["certificate-authority-data"]),
            cert: pem(config.users[0].user["client-certificate-data"]),
            key: pem(config.users[0].user["client-key-data"]),
            connect: () =>
              new Promise((resolve, reject) => {
                const socket = createConnection({ host: "127.0.0.1", port });
                socket.once("connect", () => resolve(socket));
                socket.once("error", reject);
              }),
          });
        }
        await api.request("GET", "/api/v1/namespaces");
        // The API can answer reads before its Service IP allocator is ready.
        await api.request("POST", "/api/v1/namespaces/default/services?dryRun=All", {
          apiVersion: "v1",
          kind: "Service",
          metadata: { name: "manifest-readiness" },
          spec: { ports: [{ port: 80 }] },
        });
        return;
      } catch (error) {
        lastError = error;
        await delay(500);
      }
    }
    throw lastError;
  }, 180_000);

  let namespaceSequence = 0;
  beforeEach(async () => {
    owner.namespace = `manifest-e2e-${++namespaceSequence}`;
    await live().request("POST", "/api/v1/namespaces", {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: owner.namespace,
        labels: { "pod-security.kubernetes.io/enforce": "baseline" },
      },
    });
  });

  afterAll(async () => {
    try {
      await api?.dispose();
    } finally {
      await container?.remove({ force: true, v: true });
    }
  });

  it("creates, updates, retains unchanged resources and prunes only owned manifests", async () => {
    const service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: "web" },
      spec: { selector: { app: "example" }, ports: [{ port: 80 }] },
    };
    const cron = {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: "cron" },
      spec: { schedule: "0 * * * *", suspend: true, jobTemplate: { spec: job().spec } },
    };
    const secret = {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "settings" },
      stringData: { example: "test-value" },
    };
    const objects = [config("before"), secret, service, deployment(), job(), cron];
    expect((await apply(objects)).created).toHaveLength(6);
    expect((await apply(objects)).unchanged).toHaveLength(6);
    const ip = (await live().request("GET", `/api/v1/namespaces/${owner.namespace}/services/web`))
      .spec.clusterIP;
    const changedService = structuredClone(service);
    changedService.spec.ports[0]!.port = 8080;
    const changedCron = structuredClone(cron);
    changedCron.spec.schedule = "30 * * * *";
    expect(
      (
        await apply([
          config("after"),
          secret,
          changedService,
          deployment("busybox:1.36-musl"),
          job(),
          changedCron,
        ])
      ).updated,
    ).toHaveLength(4);
    expect(
      (await live().request("GET", `/api/v1/namespaces/${owner.namespace}/services/web`)).spec
        .clusterIP,
    ).toBe(ip);
    await live().request("POST", `/api/v1/namespaces/${owner.namespace}/configmaps`, {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "foreign" },
      data: { keep: "yes" },
    });
    expect((await apply([])).deleted).toHaveLength(6);
    expect(
      (await live().request("GET", `/api/v1/namespaces/${owner.namespace}/configmaps/foreign`)).data
        .keep,
    ).toBe("yes");
  });

  it("rejects immutable changes and late schema failures before changing earlier resources", async () => {
    await apply([config("before"), deployment(), job()]);
    for (const changed of [
      [config("after"), deployment("busybox:1.37-musl", "different-selector"), job()],
      [config("after"), deployment(), job("busybox:1.36-musl")],
      [
        config("after"),
        { ...deployment(), spec: { ...deployment().spec, unknownField: true } },
        job(),
      ],
    ]) {
      await expect(apply(changed)).rejects.toThrow();
      expect(
        (await live().request("GET", `/api/v1/namespaces/${owner.namespace}/configmaps/settings`))
          .data.value,
      ).toBe("before");
    }
  });

  it("rejects reserved pod ownership before any API request", () => {
    const object = deployment();
    Object.assign(object.spec.template.metadata.labels, {
      "openship.io/deployment": "existing-release",
    });
    expect(() => admitProjectManifests([object], owner)).toThrow(/reserved label/);
  });
});
