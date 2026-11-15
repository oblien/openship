import { createHash } from "node:crypto";
import type { ProviderService } from "./types";

/** Used during discovery and after the user supplies non-exportable secrets.
 * Database addresses remain in the encrypted draft; only dependency IDs leave it. */
export function discoverExternalDatabases(app: ProviderService, services: ProviderService[]): void {
  const identity = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (!["postgres:", "postgresql:"].includes(url.protocol)) return;
      return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
    } catch {
      return;
    } // An arbitrary environment value need not be a URL.
  };
  for (const [key, value] of Object.entries(app.env)) {
    const address = identity(value);
    if (!address) continue;
    let database = services.find(
      (s) => s.externalDatabase && identity(s.externalDatabase) === address,
    );
    if (!database) {
      const id = `external-${createHash("sha256").update(address).digest("hex").slice(0, 16)}`;
      const number = services.filter((s) => s.externalDatabase).length + 1;
      database = {
        id,
        name: `${app.name} PostgreSQL${number > 1 ? ` ${number}` : ""}`,
        kind: "database",
        database: "pg_dump",
        externalDatabase: value,
        env: {},
        rawEnv: {},
        variables: [],
        volumes: [{ id, mountPath: "/var/lib/postgresql/data" }],
        domains: [],
        warnings: [
          "Keep this database at its provider, or copy one database to a compatible PostgreSQL version. Provider authentication, storage and other services stay external.",
        ],
        blockers: [],
      };
      services.push(database);
    }
    app.rawEnv[key] = `\${{${database.id}.DATABASE_URL}}`;
  }
}
