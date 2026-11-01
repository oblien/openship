import type { BuildConfig } from "../../types";
import { validateImageReference } from "@repo/core";
import { sq } from "../build-pipeline";

export const MANAGED_NODE_LABEL = "io.openship.managed-node-listener";
export const MANAGED_NODE_PORTS = "OPENSHIP_MANAGED_PUBLIC_PORTS";

/** Loaded by Node, not inserted into or evaluated from application source. */
export const managedNodeListenerSource = `"use strict";
const net = require("node:net");
const ports = new Set((process.env.${MANAGED_NODE_PORTS} || "").split(",").filter(p => /^\\d+$/.test(p)).map(Number).filter(p => p > 0 && p <= 65535));
if (ports.size) {
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function (...args) {
    const options = args[0];
    const object = options !== null && typeof options === "object";
    const port = object ? options.port : options;
    const host = object ? options.host : args[1];
    const tcp = !object || (!options.path && options.fd === undefined && options.handle === undefined);
    if (tcp && (typeof port === "number" || typeof port === "string" && /^\\d+$/.test(port)) && ports.has(Number(port)) && ["127.0.0.1", "localhost", "::1"].includes(host)) {
      if (object) args[0] = { ...options, host: "0.0.0.0" };
      else args[1] = "0.0.0.0";
      process.stderr.write("[openship] Managed ingress enabled for application port " + port + "\\n");
    }
    return Reflect.apply(listen, this, args);
  };
}
`;

export function managedNodeEnvironment(
  labels: Record<string, string> | undefined,
  environment: Record<string, string>,
  ports: number[],
): Record<string, string> {
  if (labels?.[MANAGED_NODE_LABEL] !== "1") return environment;
  if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535))
    throw new Error("Invalid managed Node application port");
  return { ...environment, [MANAGED_NODE_PORTS]: [...new Set(ports)].join(",") };
}

/** Only our generated Cloud Node recipes receive this entrypoint. User Dockerfiles
 * and prebuilt images keep their own runtime contract. Build commands run first. */
export function managedNodeDockerLines(config: BuildConfig): string[] {
  if (
    !config.managedNodeListener ||
    config.isStatic ||
    config.hasServer === false ||
    config.packageManager === "bun" ||
    validateImageReference(config.runtimeImage) ||
    !/^(?:(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\/)?(?:library\/)?node(?::|@|$)/.test(
      config.runtimeImage,
    )
  )
    return [];
  const directory = "/opt/openship/runtime";
  const entrypoint = `#!/bin/sh\nset -e\nif [ -n "\${${MANAGED_NODE_PORTS}:-}" ]; then\n  export NODE_OPTIONS="--require=${directory}/listener.cjs \${NODE_OPTIONS:-}"\nfi\nexec "$@"\n`;
  const write = `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(directory)},{recursive:true});fs.writeFileSync(${JSON.stringify(directory + "/listener.cjs")},${JSON.stringify(managedNodeListenerSource)});fs.writeFileSync(${JSON.stringify(directory + "/entrypoint.sh")},${JSON.stringify(entrypoint)});`;
  return [
    `RUN node -e ${sq(write)}`,
    `LABEL ${MANAGED_NODE_LABEL}="1"`,
    `ENTRYPOINT ["sh", "${directory}/entrypoint.sh"]`,
  ];
}
