import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import type { HandoffManifest, InstanceHandoffCode } from "@repo/core";
import { freePort, startApi, stopApi, jsonRequest, type RunningApi } from "./fixtures/instance-api";

const apis: RunningApi[] = [];
const roots: string[] = [];
afterAll(async () => {
  for (const api of apis) await stopApi(api);
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
const post = <T>(api: RunningApi, path: string, body: unknown, token?: string) =>
  jsonRequest<T>(api.baseUrl, path, {
    method: "POST",
    body: JSON.stringify(body),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
const request = (
  code: InstanceHandoffCode,
  action: string,
  body: unknown = {},
  token = code.token,
) =>
  fetch(`${code.origin}/api/system/instance/peer/${code.id}/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

it("binds a provisioned receiver to its instance, version, authenticated chunks and source retirement proof", async () => {
  const root = await mkdtemp(join(tmpdir(), "openship-instance-protocol-"));
  roots.push(root);
  const source = await startApi({
    dbDir: join(root, "source"),
    port: await freePort(),
    secret: "source-protocol-fixture-key-1111111111111111",
  });
  apis.push(source);
  await post(source, "/api/system/upgrade-to-auth", {
    name: "Owner",
    email: "protocol@example.test",
    password: "protocol-fixture-password-123!",
  });
  const owner = await jsonRequest<{ user: { id: string } }>(
    source.baseUrl,
    "/api/auth/get-session",
  );
  const offered = await post<{ code: string }>(source, "/api/system/instance/offer", {
    direction: "source",
  });
  const sender: InstanceHandoffCode = JSON.parse(Buffer.from(offered.code, "base64url").toString());
  const bootstrapToken = "bootstrap-fixture-token-11111111111111111111";
  const target = await startApi({
    dbDir: join(root, "target"),
    port: await freePort(),
    secret: "target-protocol-fixture-key-2222222222222222",
    environment: {
      OPENSHIP_INSTANCE_RECEIVE_TOKEN: bootstrapToken,
      OPENSHIP_INSTANCE_RECEIVE_ID: sender.id,
    },
  });
  apis.push(target);
  const bootstrap = { peer: sender, ownerUserId: owner.user.id };
  await expect(
    post(target, "/api/system/instance/bootstrap", bootstrap, "wrong-token"),
  ).rejects.toThrow("401");
  await expect(
    post(
      target,
      "/api/system/instance/bootstrap",
      { ...bootstrap, peer: { ...sender, id: randomUUID() } },
      bootstrapToken,
    ),
  ).rejects.toThrow("409");
  const { code: receiver, version } = await post<{ code: InstanceHandoffCode; version: string }>(
    target,
    "/api/system/instance/bootstrap",
    bootstrap,
    bootstrapToken,
  );
  expect(target.logs()).not.toContain("[boot] backup runner:");
  expect((await request(sender, "bind", { peer: receiver })).status).toBe(200);
  expect(
    (await request(sender, "bind", { peer: { ...receiver, installationId: randomUUID() } })).status,
  ).toBe(409);
  expect((await request(receiver, "prepare", {}, sender.token)).status).toBe(401);
  const manifest = (await (await request(sender, "freeze")).json()) as HandoffManifest;
  expect(version).toBe(manifest.version);
  expect(
    (await request(receiver, "stage", { manifest: { ...manifest, version: "0.0.0-incompatible" } }))
      .status,
  ).toBe(409);
  expect(
    (await request(receiver, "stage", { manifest: { ...manifest, targetId: randomUUID() } }))
      .status,
  ).toBe(409);
  expect((await request(receiver, "stage", { manifest })).status).toBe(200);
  expect((await request(receiver, "prepare")).status).toBe(409);
  for (let index = 0; index < manifest.totalChunks; index++) {
    const downloaded = await fetch(
      `${sender.origin}/api/system/instance/peer/${sender.id}/chunks/${index}`,
      { headers: { authorization: `Bearer ${sender.token}` } },
    );
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    const put = (data: Uint8Array) =>
      fetch(`${receiver.origin}/api/system/instance/peer/${receiver.id}/chunks/${index}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${receiver.token}` },
        body: Buffer.from(data),
      });
    if (index === 0) {
      const corrupted = bytes.slice();
      corrupted[corrupted.length - 1] ^= 1;
      expect((await put(corrupted)).status).toBe(400);
    }
    expect((await put(bytes)).status).toBe(200);
  }
  const prepared = await request(receiver, "prepare");
  expect(prepared.status, `${await prepared.text()}\n${target.logs()}`).toBe(200);
  expect((await request(receiver, "activate", { proof: "x".repeat(43) })).status).toBe(409);
  expect(
    (await request(sender, "retire", { manifest: { ...manifest, sha256: "0".repeat(64) } })).status,
  ).toBe(409);
  expect((await fetch(`${source.baseUrl}/api/projects`)).status).toBe(503);
  expect((await fetch(`${target.baseUrl}/api/projects`)).status).toBe(503);
  const cancellation = await (await request(sender, "abort")).json();
  expect((await request(receiver, "abort", { proof: cancellation })).status).toBe(200);
  expect((await request(receiver, "activate", { proof: "x".repeat(43) })).status).toBe(401);
  expect((await fetch(`${source.baseUrl}/api/projects`)).status).toBe(200);
}, 120_000);
