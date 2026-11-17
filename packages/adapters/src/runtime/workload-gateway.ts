import type Dockerode from "dockerode";
import { sq } from "./build-pipeline";

/** The gateway only balances transport connections. The existing Edge owns HTTP/TLS policy. */
export function workloadGatewayConfig(
  targets: readonly string[],
  ports: readonly string[],
): string {
  if (!targets.length || targets.some((name) => !/^[a-z0-9][a-z0-9-]{0,200}$/.test(name)))
    throw new Error("Invalid gateway workload identity");
  const streams = [...new Set(ports)].map((value) => {
    const match = /^(\d+)\/(tcp|udp)$/.exec(value);
    const [, port, protocol] = match ?? [];
    if (!match || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid gateway port");
    const upstream = `replicas_${port}_${protocol}`;
    return `upstream ${upstream} { ${targets.map((name) => `server ${name}:${port} max_fails=1 fail_timeout=5s;`).join(" ")} }
server { listen ${port}${protocol === "udp" ? " udp reuseport" : ""}; proxy_pass ${upstream}; proxy_connect_timeout 5s; proxy_timeout 1h; proxy_next_upstream on; }`;
  });
  return `worker_processes 1; error_log /dev/stderr warn; pid /tmp/nginx.pid; events { worker_connections 4096; } stream { ${streams.join("\n")} }`;
}

/** Shared container confinement for private Swarm and single-host replica gateways. */
export function workloadGatewayContainer(
  config: string,
): Pick<Dockerode.ContainerCreateOptions, "User" | "Entrypoint" | "Cmd" | "HostConfig"> {
  return {
    User: "101:101",
    Entrypoint: [],
    Cmd: [
      "sh",
      "-c",
      `printf %s ${sq(Buffer.from(config).toString("base64"))} | base64 -d > /tmp/workload.conf && exec openresty -c /tmp/workload.conf -g 'daemon off;'`,
    ],
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16m" },
      CapDrop: ["ALL"],
      Sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
      SecurityOpt: ["no-new-privileges:true"],
      Memory: 64 * 1024 * 1024,
      PidsLimit: 32,
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "2" } },
    },
  };
}
