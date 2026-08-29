import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /mail/webmail/deploy-external` — the destination is a BINDING, so a server
 * row or a cloud workspace, and never "local".
 *
 * Webmail installs through the generic app pipeline, so its target reaches
 * `resolveTargetPlatform` like any other project's. "local" there means "the absence
 * of a binding", which the API derives per deploy; accepting it from a request body
 * let a client name this machine and get a webmail whose only address was
 * `localhost` — for a box that, on a server-host, is already in the server list.
 */

const h = vi.hoisted(() => ({
  starts: [] as Array<Record<string, unknown>>,
}));

vi.mock("./webmail-install.service", () => ({
  startWebmailDeploy: async () => ({ deploymentId: "dep-1", projectId: "prj-1" }),
  startExternalWebmailDeploy: async (_ctx: unknown, input: Record<string, unknown>) => {
    h.starts.push(input);
    return { deploymentId: "dep-1", projectId: "prj-1" };
  },
}));

vi.mock("./webmail.service", () => ({ listWebmailTargets: async () => [] }));

vi.mock("../../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "u1", organizationId: "org1", role: "owner" }),
}));

const { startExternalDeployAsProjectHandler } = await import("./webmail.controller");

/** Enough of a Hono context for this handler: a JSON body in, a JSON reply out. */
function context(body: unknown) {
  const sent: { body: unknown; status: number } = { body: undefined, status: 0 };
  const c = {
    req: { json: async () => body },
    json: (payload: unknown, status = 200) => {
      sent.body = payload;
      sent.status = status;
      return payload as never;
    },
  };
  return { c: c as never, sent };
}

/** A request that differs only in its target. */
const withTarget = (target: unknown) => ({
  hostname: "mail.example.com",
  backend: {
    provider: "custom",
    imapHost: "imap.example.com",
    imapPort: 993,
    smtpHost: "smtp.example.com",
    smtpPort: 587,
  },
  target,
});

beforeEach(() => {
  h.starts = [];
});

describe("deploy-external target validation", () => {
  it("rejects 'local' with a 400 naming the two destinations", async () => {
    const { c, sent } = context(withTarget({ deployTarget: "local" }));
    await startExternalDeployAsProjectHandler(c);
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toMatch(/"server" or "cloud"/);
    // Terminated before the install: a refused destination must not queue a deploy.
    expect(h.starts).toEqual([]);
  });

  it("rejects a missing or unknown target the same way", async () => {
    for (const target of [undefined, {}, { deployTarget: "" }, { deployTarget: "server-ish" }]) {
      const { c, sent } = context(withTarget(target));
      await startExternalDeployAsProjectHandler(c);
      expect(sent.status).toBe(400);
    }
    expect(h.starts).toEqual([]);
  });

  it("accepts cloud, and a server WITH the row it binds to", async () => {
    const cloud = context(withTarget({ deployTarget: "cloud" }));
    await startExternalDeployAsProjectHandler(cloud.c);
    expect(cloud.sent.status).toBe(200);
    expect(h.starts[0]?.target).toEqual({ deployTarget: "cloud", serverId: undefined });

    const server = context(withTarget({ deployTarget: "server", serverId: "srv-1" }));
    await startExternalDeployAsProjectHandler(server.c);
    expect(server.sent.status).toBe(200);
    expect(h.starts[1]?.target).toEqual({ deployTarget: "server", serverId: "srv-1" });
  });

  it("a server target without a serverId is refused, not silently treated as this box", async () => {
    const { c, sent } = context(withTarget({ deployTarget: "server" }));
    await startExternalDeployAsProjectHandler(c);
    expect(sent.status).toBe(400);
    expect((sent.body as { error: string }).error).toMatch(/target\.serverId is required/);
    expect(h.starts).toEqual([]);
  });
});
