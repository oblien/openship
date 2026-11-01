import { createHash } from "node:crypto";
import type { ClusterRuntimeHost } from "@repo/core";
import { clusterObject, ensureClusterAddonObject, waitForClusterResource } from "./database-addons";
import { patchKubernetesObject } from "./kubernetes-mutation";
import type { KubernetesApi, KubernetesObject } from "./kubernetes-api";
import { runClusterJob } from "./job";

const FILE_CHECK_FAILED = 65;

/** A real cross-server file roundtrip, using only disposable owned resources. */
export class StorageProbe {
  readonly namespace: string;
  private readonly labels: Record<string, string>;
  constructor(
    private api: KubernetesApi,
    private runtimeId: string,
    private signal: AbortSignal,
    private fence: () => Promise<void>,
  ) {
    this.namespace = `openship-storage-check-${createHash("sha256").update(runtimeId).digest("hex").slice(0, 16)}`;
    this.labels = { "openship.io/runtime": runtimeId, "openship.io/storage-check": "true" };
  }
  private assertOwned(object: KubernetesObject) {
    if (Object.entries(this.labels).some(([key, value]) => object.metadata.labels?.[key] !== value))
      throw new Error("A storage check resource has different ownership. It was left unchanged.");
  }
  private ensure(object: KubernetesObject) {
    object.metadata.labels = { ...object.metadata.labels, ...this.labels };
    return ensureClusterAddonObject(
      this.api,
      object,
      this.runtimeId,
      "longhorn",
      this.signal,
      this.fence,
    );
  }
  async run(
    storageClass: KubernetesObject,
    hosts: Pick<ClusterRuntimeHost, "name" | "nodeName">[],
    log: (message: string) => Promise<void>,
  ) {
    await this.ensure({
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: this.namespace,
        labels: { "pod-security.kubernetes.io/enforce": "restricted" },
      },
    });
    const probeClass = {
      ...storageClass,
      metadata: { ...storageClass.metadata, name: this.namespace },
      reclaimPolicy: "Delete",
    };
    await this.ensure(probeClass);
    await this.ensure({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "roundtrip", namespace: this.namespace },
      spec: {
        accessModes: ["ReadWriteMany"],
        storageClassName: this.namespace,
        resources: { requests: { storage: "1Gi" } },
      },
    });
    const token = createHash("sha256").update(this.runtimeId).digest("hex");
    for (const [index, host] of hosts.entries()) {
      await log(`${host.name}: ${index === 0 ? "writing" : "reading"} the shared test file.`);
      await runClusterJob(
        this.api,
        {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: { name: `check-${index}`, namespace: this.namespace, labels: this.labels },
          spec: {
            // Recovery may delete the pod during shell startup (exit 2 as well
            // as 137/143). Only our explicit file-check exit proves a data error.
            // Other exits consume the bounded replacement budget; none count as
            // success. Native backup and import jobs stay separate.
            backoffLimit: 2,
            activeDeadlineSeconds: 300,
            podFailurePolicy: {
              rules: [
                {
                  action: "FailJob",
                  onExitCodes: {
                    containerName: "check",
                    operator: "In",
                    values: [FILE_CHECK_FAILED],
                  },
                },
              ],
            },
            template: {
              metadata: { labels: this.labels },
              spec: {
                restartPolicy: "Never",
                automountServiceAccountToken: false,
                nodeSelector: { "kubernetes.io/hostname": host.nodeName },
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: 1000,
                  runAsGroup: 1000,
                  fsGroup: 1000,
                  seccompProfile: { type: "RuntimeDefault" },
                },
                containers: [
                  {
                    name: "check",
                    image: "busybox:1.37.0",
                    command: [
                      "sh",
                      "-ec",
                      [
                        `fail() { printf '%s\\n' "$1" >&2; exit ${FILE_CHECK_FAILED}; }`,
                        ...(index === 0
                          ? [
                              'printf "%s" "$1" > /shared/roundtrip || fail "Cannot write the shared test file"',
                              'sync || fail "Cannot flush the shared test file"',
                            ]
                          : []),
                        'value=$(cat /shared/roundtrip) || fail "Cannot read the shared test file"',
                        '[ "$value" = "$1" ] || fail "Shared test file contents do not match"',
                        `printf "Shared file ${index === 0 ? "written" : "read"} and verified\\n"`,
                      ].join("\n"),
                      "check",
                      token,
                    ],
                    securityContext: {
                      allowPrivilegeEscalation: false,
                      readOnlyRootFilesystem: true,
                      capabilities: { drop: ["ALL"] },
                    },
                    resources: {
                      requests: { cpu: "10m", memory: "16Mi" },
                      limits: { cpu: "100m", memory: "32Mi" },
                    },
                    volumeMounts: [{ name: "data", mountPath: "/shared" }],
                  },
                ],
                volumes: [{ name: "data", persistentVolumeClaim: { claimName: "roundtrip" } }],
              },
            },
          },
        },
        { signal: this.signal, fence: this.fence, retryFailed: true, log },
      );
    }
    await this.cleanup();
    await log(`Shared files were written and read successfully across ${hosts.length} servers.`);
  }
  async cleanup() {
    const path = `/api/v1/namespaces/${this.namespace}`;
    const ns = await clusterObject(this.api, path, this.signal);
    if (ns) {
      this.assertOwned(ns);
      // The probe class uses Delete, so namespace deletion cleans only test data.
      const claims = await this.api.request<{ items: KubernetesObject[] }>(
        "GET",
        `${path}/persistentvolumeclaims`,
        undefined,
        this.signal,
      );
      for (const claim of claims.items) {
        this.assertOwned(claim);
        if (claim.spec.volumeName)
          await patchKubernetesObject(
            this.api,
            `/api/v1/persistentvolumes/${claim.spec.volumeName}`,
            async (pv) => {
              if (
                pv.spec.claimRef?.uid !== claim.metadata.uid ||
                pv.spec.csi?.driver !== "driver.longhorn.io"
              )
                throw new Error("The storage check disk changed ownership.");
              await this.fence();
              return { spec: { persistentVolumeReclaimPolicy: "Delete" } };
            },
            this.signal,
          );
      }
      await this.fence();
      if (!ns.metadata.deletionTimestamp)
        await this.api.request(
          "DELETE",
          path,
          { preconditions: { uid: ns.metadata.uid } },
          this.signal,
        );
      await waitForClusterResource(
        this.signal,
        async () => (!(await clusterObject(this.api, path, this.signal)) ? true : null),
        "shared storage test cleanup",
        240_000,
      );
      for (const claim of claims.items)
        if (claim.spec.volumeName)
          await waitForClusterResource(
            this.signal,
            async () =>
              !(await clusterObject(
                this.api,
                `/api/v1/persistentvolumes/${claim.spec.volumeName}`,
                this.signal,
              ))
                ? true
                : null,
            "shared storage test disk cleanup",
            240_000,
          );
    }
    const classPath = `/apis/storage.k8s.io/v1/storageclasses/${this.namespace}`;
    const storageClass = await clusterObject(this.api, classPath, this.signal);
    if (storageClass) {
      this.assertOwned(storageClass);
      await this.fence();
      await this.api.request(
        "DELETE",
        classPath,
        { preconditions: { uid: storageClass.metadata.uid } },
        this.signal,
      );
    }
  }
}
