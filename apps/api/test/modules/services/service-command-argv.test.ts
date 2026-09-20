import { beforeEach, describe, expect, it, vi } from "vitest";

const projectRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serviceRepo = vi.hoisted(() => ({
  findById: vi.fn(),
  update: vi.fn(),
  listByProject: vi.fn(),
  syncFromCompose: vi.fn(),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: { ...actual.repos, project: projectRepo, service: serviceRepo },
  };
});

import { syncComposeServices, updateService } from "@repo/platform/engine/modules/services/service.service";
import { toComposeSpec } from "@repo/db";
import { mergeServiceDeployEnv } from "@repo/platform/engine/modules/deployments/compose/service-env-layers";

/**
 * #332 left the EDITORS behind: the compose parser produced `commandArgv`, but
 * every writer that takes a text `command` ignored it. Two live consequences,
 * both covered here:
 *   • PATCH — argv wins at deploy time, so a stale argv kept running the OLD
 *     command. The service form's command field did nothing on any row imported
 *     from a compose file.
 *   • sync/deploy — those wire shapes took only the string, and the stored string
 *     is a lossy display join for a list command, so a read-then-post-back re-split
 *     `["sh","-c","a && b"]` into five words. That decision now lives one layer
 *     down, in composeWritePatch (see packages/db compose-spec-command.test.ts).
 */
const ctx = { organizationId: "org_1" } as never;
const project = { id: "proj_1", organizationId: "org_1", internalAlias: null };

const row = (over: Record<string, unknown> = {}) => ({
  id: "svc_1",
  projectId: project.id,
  name: "web",
  kind: "compose",
  image: "ghcr.io/acme/app:1",
  command: "server start",
  commandArgv: ["server", "start"],
  environment: {},
  ports: [],
  restart: "unless-stopped",
  enabled: true,
  exposed: false,
  ...over,
});

/** The patch handed to repos.service.update. */
const written = () => serviceRepo.update.mock.calls.at(-1)?.[1] as Record<string, unknown>;
/** The entries handed to repos.service.syncFromCompose. */
const synced = () =>
  serviceRepo.syncFromCompose.mock.calls.at(-1)?.[1] as Array<Record<string, unknown>>;

beforeEach(() => {
  projectRepo.findById.mockReset().mockResolvedValue(project);
  serviceRepo.findById.mockReset().mockResolvedValue(row());
  serviceRepo.update.mockReset().mockResolvedValue(undefined);
  serviceRepo.listByProject.mockReset().mockResolvedValue([]);
  serviceRepo.syncFromCompose.mockReset().mockResolvedValue([]);
});

describe("updateService — command edits keep argv in step", () => {
  it("re-derives argv on a command edit, so the new command actually runs", async () => {
    await updateService(ctx, project.id, "svc_1", { command: "server start --verbose" } as never);

    expect(written().command).toBe("server start --verbose");
    expect(written().commandArgv).toEqual(["server", "start", "--verbose"]);
  });

  it("gives a row with no argv real argv instead of resurrecting the `sh -c` wrap", async () => {
    serviceRepo.findById.mockResolvedValue(row({ command: null, commandArgv: null }));

    await updateService(ctx, project.id, "svc_1", { command: "server start" } as never);

    expect(written().commandArgv).toEqual(["server", "start"]);
  });

  it("does not touch argv when the patch never mentions the command", async () => {
    await updateService(ctx, project.id, "svc_1", { restart: "always" } as never);

    expect(written()).not.toHaveProperty("commandArgv");
  });

  it("keeps a list command intact when the form echoes its lossy display join back", async () => {
    // `command: ["sh","-c","a && b"]` is STORED as "sh -c a && b" for display. The
    // service form posts every field it owns, so any unrelated save re-sends that
    // string — re-splitting it would hand the container five arguments.
    serviceRepo.findById.mockResolvedValue(
      row({ command: "sh -c a && b", commandArgv: ["sh", "-c", "a && b"] }),
    );

    await updateService(ctx, project.id, "svc_1", {
      command: "sh -c a && b",
      restart: "always",
    } as never);

    expect(written().commandArgv).toEqual(["sh", "-c", "a && b"]);
  });

  it("clears argv when the command field is cleared", async () => {
    await updateService(ctx, project.id, "svc_1", { command: "" } as never);

    expect(written().command).toBeNull();
    expect(written().commandArgv).toBeNull();
  });

  it("lets an explicit argv win over the string", async () => {
    await updateService(ctx, project.id, "svc_1", {
      command: "sh -c 'a && b'",
      commandArgv: ["sh", "-c", "a && b"],
    } as never);

    expect(written().commandArgv).toEqual(["sh", "-c", "a && b"]);
  });
});

describe("syncComposeServices — hands the command to the repo untouched", () => {
  // The argv DECISION lives in composeWritePatch (packages/db), so that every
  // writer into syncFromCompose gets it — including the deploy request's service
  // list, which never passes through this function. What this layer owes is not
  // mangling the command on the way there, while still restoring masked env.
  it("forwards an explicit argv verbatim (what the CLI sends)", async () => {
    serviceRepo.listByProject.mockResolvedValue([row()]);

    await syncComposeServices(ctx, project.id, [
      {
        name: "web",
        image: "ghcr.io/acme/app:1",
        command: "sh -c a && b",
        commandArgv: ["sh", "-c", "a && b"],
      },
    ]);

    expect(synced()[0]?.commandArgv).toEqual(["sh", "-c", "a && b"]);
    expect(synced()[0]?.command).toBe("sh -c a && b");
  });

  it("restores masked env without inventing an argv the caller didn't send", async () => {
    serviceRepo.listByProject.mockResolvedValue([row({ environment: { SECRET: "real-value" } })]);

    await syncComposeServices(ctx, project.id, [
      {
        name: "web",
        image: "ghcr.io/acme/app:1",
        command: "server start --verbose",
        environment: { SECRET: "••••••••" },
      },
    ]);

    expect(synced()[0]?.environment).toEqual({ SECRET: "real-value" });
    expect(synced()[0]).not.toHaveProperty("commandArgv");
  });

  it("#854: restores build args during compose sync and masks its response", async () => {
    serviceRepo.listByProject.mockResolvedValue([row({ buildArgs: { TOKEN: "stored-token" } })]);
    serviceRepo.syncFromCompose.mockImplementation(async (_project, services) =>
      services.map((service: object) => row(service)),
    );
    const response = await syncComposeServices(ctx, project.id, [
      {
        name: "web",
        buildArgs: { TOKEN: "••••••••", INHERITED: null, GHOST: "••••••••" },
      },
    ]);
    expect(synced()[0].buildArgs).toEqual({ TOKEN: "stored-token", INHERITED: null });
    expect(response[0]?.buildArgs).toEqual({ TOKEN: "••••••••", INHERITED: null });
    expect(JSON.stringify(response)).not.toContain("stored-token");
  });

  it("preserves Compose env expressions and resolves them from project env at deploy (#751)", async () => {
    await syncComposeServices(ctx, project.id, [
      {
        name: "web",
        image: "ghcr.io/acme/app:1",
        environment: {
          APP_KEY: "${APP_KEY}",
          APP_URL: "https://${APP_HOST}/api",
          ESCAPED_LITERAL: "$${APP_HOST}",
          NODE_ENV: "production",
        },
      },
    ]);

    const imported = synced()[0]!;
    expect(imported.environmentTemplates).toEqual({
      APP_KEY: "${APP_KEY}",
      APP_URL: "https://${APP_HOST}/api",
      ESCAPED_LITERAL: "$${APP_HOST}",
    });

    // Exercise the same DB normalization + deploy env merge used by a real
    // service row, rather than only asserting the API's intermediate object.
    const spec = toComposeSpec(imported);
    expect(spec.advanced?.environmentTemplateKeys).toEqual([
      "APP_KEY",
      "APP_URL",
      "ESCAPED_LITERAL",
    ]);
    const deployed = mergeServiceDeployEnv(
      {
        project: { APP_KEY: "secret-value", APP_HOST: "app.example.com" },
        frozen: {},
        inline: spec.environment,
        templateKeys: spec.advanced?.environmentTemplateKeys,
        service: {},
      },
      false,
    );
    expect(deployed.env).toMatchObject({
      APP_KEY: "secret-value",
      APP_URL: "https://app.example.com/api",
      ESCAPED_LITERAL: "${APP_HOST}",
      NODE_ENV: "production",
    });
    expect(deployed.missingRequired).toEqual([]);
  });

  it("honors an explicit normalized marker instead of expanding a dollar twice", async () => {
    await syncComposeServices(ctx, project.id, [
      {
        name: "web",
        environment: { ESCAPED_LITERAL: "${APP_HOST}" },
        advanced: { environmentTemplateKeys: [] },
      },
    ]);

    expect(synced()[0]?.environment).toEqual({ ESCAPED_LITERAL: "${APP_HOST}" });
    expect(synced()[0]).not.toHaveProperty("environmentTemplates");
    expect(synced()[0]?.advanced).toMatchObject({ environmentTemplateKeys: [] });
  });

  it("records empty provenance so an authored blank can clear a project value", async () => {
    await syncComposeServices(ctx, project.id, [
      { name: "web", environment: { HTTP_PROXY: "" } },
    ]);

    const spec = toComposeSpec(synced()[0]!);
    expect(spec.advanced?.environmentTemplateKeys).toEqual([]);
    const deployed = mergeServiceDeployEnv(
      {
        project: { HTTP_PROXY: "http://corp:3128" },
        frozen: {},
        inline: spec.environment,
        templateKeys: spec.advanced?.environmentTemplateKeys,
        service: {},
      },
      false,
    );
    expect(deployed.env.HTTP_PROXY).toBe("");
    expect(deployed.deferredEmpty).toEqual([]);
  });
});
