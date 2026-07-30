import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Regression guard for the cross-serving hole: the CONTAINERIZED edge uses a
// baked apps/edge/nginx.conf (COPYed into the image), NOT ensureOpenRestyConfig's
// DEFAULT_BLOCK (that path only runs on a bare edge). The two must stay in sync —
// both need a 443 default_server that rejects unknown SNI, else an unrouted HTTPS
// host falls through to the first-loaded 443 vhost and gets another app's backend.
describe("baked edge nginx.conf (containerized edge)", () => {
  const conf = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../edge/nginx.conf"),
    "utf-8",
  );

  test("owns the 443 default_server and rejects unknown SNI", () => {
    expect(conf).toContain("listen 443 ssl default_server;");
    expect(conf).toContain("ssl_reject_handshake on;");
  });

  test("still owns the 80 default_server catch-all (no HTTP fallthrough)", () => {
    expect(conf).toContain("listen 80 default_server;");
  });
});
