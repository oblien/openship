import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { SetSleepModeBody, LinkRepoBody, SetOptionsBody } from "../../../src/modules/projects/project.schema";
import { CreateChannelBody, UpsertSubscriptionBody } from "../../../src/modules/notifications/notification.schema";
import { CreateConnectionBody, CreateBundleBody } from "../../../src/modules/projects/project-connection.schema";
import { PrepareDeployBody, BuildRespondBody } from "../../../src/modules/deployments/deployment.schema";

/**
 * The MCP write-tool body schemas are wired via `spec.body`, so they both
 * validate real requests AND type the MCP tool. These assert the trickier ones
 * accept valid bodies and reject invalid — the shapes mirror what each
 * controller actually reads (see the per-handler audit).
 */

const ok = (schema: TSchema, v: unknown) => Value.Check(schema, v);

describe("MCP write-tool body schemas", () => {
  it("SetSleepModeBody: snake_case key, enum-gated", () => {
    expect(ok(SetSleepModeBody, { sleep_mode: "auto_sleep" })).toBe(true);
    expect(ok(SetSleepModeBody, { sleep_mode: "always_on" })).toBe(true);
    expect(ok(SetSleepModeBody, { sleep_mode: "sometimes" })).toBe(false);
    expect(ok(SetSleepModeBody, { sleepMode: "auto_sleep" })).toBe(false); // wrong key
    expect(ok(SetSleepModeBody, {})).toBe(false);
  });

  it("LinkRepoBody: owner+repo required, branch/installationId optional", () => {
    expect(ok(LinkRepoBody, { owner: "acme", repo: "web" })).toBe(true);
    expect(ok(LinkRepoBody, { owner: "acme", repo: "web", branch: "main", installationId: 42 })).toBe(true);
    expect(ok(LinkRepoBody, { owner: "acme" })).toBe(false); // repo missing
    expect(ok(LinkRepoBody, { owner: "acme", repo: "web", installationId: "42" })).toBe(false); // wrong type
  });

  it("SetOptionsBody: all optional + open (free-form config route)", () => {
    expect(ok(SetOptionsBody, {})).toBe(true);
    expect(ok(SetOptionsBody, { buildCommand: "npm run build", productionPort: 3000 })).toBe(true);
    expect(ok(SetOptionsBody, { productionPort: "3000" })).toBe(true); // port accepts string too
    expect(ok(SetOptionsBody, { somethingNew: "x" })).toBe(true); // additionalProperties allowed
  });

  it("CreateChannelBody: kind enum + label required, config open", () => {
    expect(ok(CreateChannelBody, { kind: "webhook", label: "ops", config: { url: "https://x" } })).toBe(true);
    expect(ok(CreateChannelBody, { kind: "in_app", label: "me" })).toBe(true); // config optional
    expect(ok(CreateChannelBody, { kind: "carrier-pigeon", label: "x" })).toBe(false);
    expect(ok(CreateChannelBody, { kind: "email" })).toBe(false); // label required
  });

  it("UpsertSubscriptionBody: category/channelId/enabled required", () => {
    expect(ok(UpsertSubscriptionBody, { category: "deploy.failed", channelId: "c1", enabled: true })).toBe(true);
    expect(ok(UpsertSubscriptionBody, { category: "deploy.failed", channelId: "c1" })).toBe(false);
    expect(ok(UpsertSubscriptionBody, { category: "deploy.failed", channelId: "c1", enabled: "yes" })).toBe(false);
  });

  it("connection bodies: required ids + mode enum, bundle needs ≥1 item", () => {
    expect(ok(CreateConnectionBody, { sourceProjectId: "p", outputId: "o", envKey: "DB_URL" })).toBe(true);
    expect(ok(CreateConnectionBody, { sourceProjectId: "p", outputId: "o", envKey: "DB_URL", mode: "internal" })).toBe(true);
    expect(ok(CreateConnectionBody, { sourceProjectId: "p", outputId: "o", envKey: "DB_URL", mode: "carrier" })).toBe(false);
    expect(ok(CreateBundleBody, { sourceProjectId: "p", items: [{ outputId: "o", envKey: "K" }] })).toBe(true);
    expect(ok(CreateBundleBody, { sourceProjectId: "p", items: [] })).toBe(false); // minItems 1
  });

  it("deploy prepare/respond: prepare all-optional, respond needs action", () => {
    expect(ok(PrepareDeployBody, {})).toBe(true);
    expect(ok(PrepareDeployBody, { source: "github", owner: "a", repo: "b", branch: "main" })).toBe(true);
    expect(ok(PrepareDeployBody, { source: "svn" })).toBe(false);
    expect(ok(BuildRespondBody, { action: "approve" })).toBe(true);
    expect(ok(BuildRespondBody, {})).toBe(false);
  });
});
