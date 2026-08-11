import "./_setup-env";
import { describe, expect, test } from "vitest";
import { ACME_HTTP01_PORT } from "@repo/adapters";

import { stepRequestSSL } from "../../../src/modules/mail/mail.service";

/**
 * The edge's default server PROXIES /.well-known/acme-challenge/ to certbot's
 * standalone listener on a loopback alt-port — it does not serve files. Step 12
 * used `--webroot -w /var/www/acme`, so the challenge was written where nothing
 * reads it and every issuance 404'd.
 */
function certbotExecutor() {
  const streamed: string[] = [];
  const executor = {
    exec: async () => "",
    streamExec: async (command: string) => {
      streamed.push(command);
      return { code: 0, output: "" };
    },
  } as never;
  return { executor, streamed };
}

describe("step 12 certificate issuance", () => {
  test("uses the standalone authenticator on the port the edge proxies to", async () => {
    const { executor, streamed } = certbotExecutor();

    const result = await stepRequestSSL(executor, "example.com", () => {});

    expect(result.success).toBe(true);
    const certbot = streamed.find((c) => c.includes("certbot"))!;
    expect(certbot).toContain("--standalone");
    expect(certbot).toContain(`--http-01-port ${ACME_HTTP01_PORT}`);
    expect(certbot).not.toContain("--webroot");
  });

  test("pins the lineage name so step 13 can find the cert", async () => {
    const { executor, streamed } = certbotExecutor();

    await stepRequestSSL(executor, "example.com", () => {});

    const certbot = streamed.find((c) => c.includes("certbot"))!;
    expect(certbot).toContain("--cert-name 'mail.example.com'");
    expect(certbot).toContain("-d 'mail.example.com'");
  });

  test("refuses a domain that isn't shell-safe before it reaches certbot", async () => {
    const { executor, streamed } = certbotExecutor();

    const result = await stepRequestSSL(executor, "evil;rm -rf /", () => {});

    expect(result.success).toBe(false);
    expect(streamed).toHaveLength(0);
  });
});
