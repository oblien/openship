import "./_setup-env";
import { describe, expect, test, vi } from "vitest";

/**
 * Step 9 used to run the host-native `iRedMail.sh`. It now DEPLOYS the mail engine
 * as the `openship-mail` container (+ postgres sidecar) via `ensureContainerMail`,
 * so the assertions flipped: it must call the container launcher with the domain +
 * generated secrets, and must NOT shell out to `iRedMail.sh` anywhere.
 */
// Hoisted so the vi.mock factory (itself hoisted above imports) can reference it.
const { ensureContainerMail } = vi.hoisted(() => ({
  ensureContainerMail: vi.fn(async () => ({
    container: "openship-mail",
    dbContainer: "openship-mail-db",
    image: "ghcr.io/oblien/openship-mail:test",
  })),
}));

vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  ensureContainerMail,
}));

// Health-gate reports everything up so the step reaches its success return.
vi.mock("../../../src/modules/mail/mail-health.service", () => ({
  checkMailHealth: vi.fn(async () => [
    { key: "postfix", label: "Postfix", description: "", unit: "postfix", status: "active" },
    { key: "dovecot", label: "Dovecot", description: "", unit: "dovecot", status: "active" },
    { key: "postgresql", label: "PostgreSQL", description: "", unit: "postgresql", status: "active" },
  ]),
  MAIL_COMPONENTS: [],
}));

import { stepDeployEngine } from "../../../src/modules/mail/mail.service";

/** Every command succeeds; capture anything streamed so we can assert no iRedMail.sh. */
function engineExecutor() {
  const streamed: string[] = [];
  const executor = {
    exec: async () => "",
    writeFile: async () => undefined,
    streamExec: async (command: string) => {
      streamed.push(command);
      return { code: 0, output: "" };
    },
  } as never;
  return { executor, streamed };
}

describe("step 5 engine deploy", () => {
  test("deploys the openship-mail container with the domain + secrets", async () => {
    ensureContainerMail.mockClear();
    const { executor } = engineExecutor();

    const result = await stepDeployEngine(executor, "example.com", () => {});

    expect(result.success).toBe(true);
    expect(ensureContainerMail).toHaveBeenCalledOnce();
    const opts = ensureContainerMail.mock.calls[0][1] as {
      domain: string;
      secrets: Record<string, string>;
    };
    expect(opts.domain).toBe("example.com");
    // The generated iRedMail secrets are handed to the container's first-boot env.
    expect(opts.secrets.DOMAIN_ADMIN_PASSWD_PLAIN).toEqual(expect.any(String));
    expect(opts.secrets.PGSQL_ROOT_PASSWD).toEqual(expect.any(String));
    // And the postmaster password is surfaced back for the dashboard.
    expect(result.data?.secrets?.DOMAIN_ADMIN_PASSWD_PLAIN).toEqual(expect.any(String));
  });

  test("never runs the host-native iRedMail.sh installer", async () => {
    ensureContainerMail.mockClear();
    const { executor, streamed } = engineExecutor();

    await stepDeployEngine(executor, "example.com", () => {});

    expect(streamed.some((c) => c.includes("iRedMail.sh"))).toBe(false);
  });
});
