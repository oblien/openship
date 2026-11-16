import { expect, it } from "vitest";
import { auth } from "@repo/platform/engine/lib/auth";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";
import { mintSession } from "../../src/lib/cloud-auth-proxy";
import { db, schema, eq } from "@repo/db";
import { randomUUID } from "node:crypto";

it("updates only the signed-in user's avatar through the existing auth endpoint and rejects unsafe URLs", async () => {
  const id = randomUUID();
  await provisionUser({
    id,
    email: `${id}@example.test`,
    name: "Avatar owner",
    emailVerified: true,
  });
  const session = await mintSession({ purpose: "local-cookie", userId: id });
  const update = (image: unknown, token: string | null = session.token, extra = {}) =>
    auth.handler(
      new Request("http://localhost:4000/api/auth/update-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ image, ...extra }),
      }),
    );
  expect((await update("https://cdn.example.test/avatar.png", null)).status).toBe(401);
  const result = await update("https://cdn.example.test/avatar.png");
  expect(result.status, await result.clone().text()).toBe(200);
  expect(await db.query.user.findFirst({ where: eq(schema.user.id, id) })).toMatchObject({
    image: "https://cdn.example.test/avatar.png",
    role: "user",
  });
  expect(
    await auth.api.getSession({
      headers: new Headers({ Authorization: `Bearer ${session.token}` }),
    }),
  ).toMatchObject({ user: { image: "https://cdn.example.test/avatar.png" } });
  expect(
    (await update("https://cdn.example.test/avatar.png", session.token, { role: "admin" })).status,
  ).toBe(400);
  for (const image of [
    "javascript:alert(1)",
    "data:image/svg+xml,<svg/>",
    "https://user:secret@example.test/a.png",
    "/avatar.png",
    123,
  ])
    expect((await update(image)).status).toBe(400);
  expect((await update(null)).status).toBe(200);
  expect(await db.query.user.findFirst({ where: eq(schema.user.id, id) })).toMatchObject({
    image: null,
  });
});
