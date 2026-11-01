/** One protocol for moving an instance in either direction. Never reactivates a
 * source after retirement: a lost activation response must be retried, not
 * interpreted as permission to start a second controller. */
export const INSTANCE_HANDOFF_PROTOCOL = 1;

export type ControllerRole =
  | "active"
  | "quiescing"
  | "frozen"
  | "receiving"
  | "prepared"
  | "retired"
  | "connected";
export type InstanceAccess = "desktop" | "browser";
export type HandoffPhase = "preparing" | "copying" | "verifying" | "switching" | "complete";

export interface InstanceConnection {
  origin: string;
  installationId: string;
  /** Remote auth cookies stay encrypted in the bridge, including a pending 2FA
   * challenge. They are never set on the Desktop browser's origin. */
  cookies: Record<string, string>;
}

export interface HandoffManifest {
  protocol: 1;
  id: string;
  sourceId: string;
  targetId: string;
  version: string;
  totalBytes: number;
  totalChunks: number;
  sha256: string;
  retirementHash: string;
  cancellationHash: string;
  ownerUserId: string;
}

export interface HandoffSource {
  freeze(): Promise<HandoffManifest>;
  chunk(index: number): Promise<Uint8Array>;
  /** Persist the source fence before revealing the one-time activation proof. */
  retire(manifest: HandoffManifest): Promise<string>;
  complete(connection: InstanceConnection): Promise<void>;
}

export interface HandoffTarget {
  stage(manifest: HandoffManifest): Promise<void>;
  chunk(index: number, bytes: Uint8Array): Promise<void>;
  /** Commit the complete database and resealed credentials while still fenced. */
  prepare(): Promise<void>;
  activate(retirementProof: string): Promise<InstanceConnection>;
}

/** Each peer persists its own steps. Calling again resumes after an interrupted
 * upload, import, retirement, or activation without exporting a newer snapshot
 * or overwriting an already activated destination. */
export async function handoffInstance(
  source: HandoffSource,
  target: HandoffTarget,
  progress: (phase: HandoffPhase) => void = () => {},
): Promise<InstanceConnection> {
  progress("preparing");
  const manifest = await source.freeze();
  await target.stage(manifest);
  progress("copying");
  for (let index = 0; index < manifest.totalChunks; index++) {
    await target.chunk(index, await source.chunk(index));
  }
  progress("verifying");
  await target.prepare();
  progress("switching");
  const proof = await source.retire(manifest);
  const connection = await target.activate(proof);
  await source.complete(connection);
  progress("complete");
  return connection;
}

/** Control-plane credentials only travel to a fixed HTTPS origin. Loopback is
 * useful for local pairing and isolated tests; no redirects or URL credentials. */
export function instanceOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/api/proxy", "/api/proxy/"].includes(url.pathname)
  ) {
    throw new Error(
      "Use the instance’s HTTPS API address, without credentials or query parameters.",
    );
  }
  return `${url.origin}${url.pathname === "/" ? "" : "/api/proxy"}`;
}

export interface InstanceHandoffCode {
  protocol: 1;
  id: string;
  origin: string;
  installationId: string;
  direction: "source" | "target";
  token: string;
  key: string;
}
