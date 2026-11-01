import { readFile } from "node:fs/promises";
import { request } from "node:https";
import { gzipSync, gunzipSync } from "node:zlib";
import type { ArchiveEntry, DatabaseTaskConfig } from "./types";

export const ARCHIVE_INDEX = "openship-archive-index";
export function decodeArchiveEntries(data?: Record<string, string>): ArchiveEntry[] {
  if (!data?.archives) return [];
  const entries = JSON.parse(
    gunzipSync(Buffer.from(data.archives, "base64"), {
      maxOutputLength: 16 * 1024 * 1024,
    }).toString(),
  );
  if (
    !Array.isArray(entries) ||
    entries.length > 20000 ||
    entries.some((row) => !row.name || !["running", "completed", "failed"].includes(row.phase))
  )
    throw new Error("The saved backup catalogue is invalid.");
  return entries;
}
export function encodeArchiveEntries(entries: ArchiveEntry[]) {
  const encoded = gzipSync(JSON.stringify(entries)).toString("base64");
  if (encoded.length > 750000)
    throw new Error(
      "The backup catalogue reached its capacity. Resolve failed archive cleanup before adding more backups.",
    );
  return encoded;
}
interface IndexObject {
  metadata: {
    uid: string;
    resourceVersion: string;
    labels?: Record<string, string>;
    deletionTimestamp?: string;
  };
  data?: Record<string, string>;
}

/** A job can update only one named ConfigMap in its own database namespace. It
 * cannot read cluster credentials, other projects, or control node membership. */
export class TaskArchiveIndex {
  constructor(
    readonly config: DatabaseTaskConfig,
    readonly signal: AbortSignal,
  ) {}
  private async api(method: string, body?: unknown): Promise<IndexObject> {
    const root = "/var/run/secrets/kubernetes.io/serviceaccount";
    const [token, ca] = await Promise.all([
      readFile(`${root}/token`, "utf8"),
      readFile(`${root}/ca.crt`),
    ]);
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "kubernetes.default.svc",
          port: 443,
          ca,
          signal: this.signal,
          method,
          path: `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/configmaps/${ARCHIVE_INDEX}`,
          headers: {
            Authorization: `Bearer ${token.trim()}`,
            ...(data
              ? { "content-type": "application/merge-patch+json", "content-length": data.length }
              : {}),
          },
        },
        (response) => {
          let output = Buffer.alloc(0);
          response.on("data", (chunk) => {
            output = Buffer.concat([output, chunk]);
            if (output.length > 2 * 1024 * 1024)
              response.destroy(new Error("The backup status response exceeded its limit."));
          });
          response.once("error", reject);
          response.once("end", () => {
            if (response.statusCode !== 200)
              return reject(
                Object.assign(
                  new Error(`Saving backup progress returned HTTP ${response.statusCode}.`),
                  { statusCode: response.statusCode },
                ),
              );
            try {
              resolve(JSON.parse(output.toString()));
            } catch {
              reject(new Error("Invalid backup status response."));
            }
          });
        },
      );
      req.setTimeout(15000, () => req.destroy(new Error("Saving backup progress timed out.")));
      req.once("error", reject);
      req.end(data);
    });
  }
  async read() {
    const row = await this.api("GET");
    if (
      row.metadata.uid !== this.config.indexUid ||
      row.metadata.deletionTimestamp ||
      row.metadata.labels?.["openship.io/database"] !== this.config.databaseId ||
      row.metadata.labels?.["openship.io/runtime"] !== this.config.runtimeId
    )
      throw new Error("The backup catalogue changed ownership. This task stopped.");
    return row;
  }
  async update(change: (data: Record<string, string>) => Record<string, string>) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await this.read();
      try {
        return await this.api("PATCH", {
          metadata: { resourceVersion: current.metadata.resourceVersion },
          data: change(current.data ?? {}),
        });
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 409 || attempt === 7) throw error;
      }
    }
    throw new Error("The backup catalogue remained busy. Retry this task.");
  }
  async entries() {
    return decodeArchiveEntries((await this.read()).data);
  }
  async save(entry: ArchiveEntry) {
    await this.update((data) => {
      const current = decodeArchiveEntries(data);
      const previous = current.find((row) => row.name === entry.name);
      if (previous?.error === "Archive retention cleanup in progress.")
        throw new Error("This archive is being removed by its retention policy.");
      // A duplicate native Job must never turn a committed backup back into
      // running/failed, or change the recovery point that a restore has pinned.
      if (previous?.phase === "completed") return data;
      return {
        ...data,
        archives: encodeArchiveEntries([
          ...current.filter((row) => row.name !== entry.name),
          { ...entry, pins: previous?.pins ?? [] },
        ]),
      };
    });
  }
}
