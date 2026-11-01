import { beforeEach, describe, expect, it } from "vitest";
import { db, eq, schema } from "@repo/db";
import { LOCAL_EMAIL, rebindLocalUserAfterInstanceRestore } from "../../src/lib/local-user";

beforeEach(async () => {
  await db.delete(schema.instanceController);
  await db.delete(schema.user);
});

async function destination(
  role: "active" | "receiving" = "active",
  handoffId: string | null = null,
) {
  await db.insert(schema.instanceController).values({
    id: "local",
    installationId: "destination-installation",
    desktopUserId: "previous-device-owner",
    role,
    handoffId,
    revision: 7,
  });
}

async function importedUser(
  input: { role?: string; autoProvisioned?: boolean; email?: string } = {},
) {
  await db.insert(schema.user).values({
    id: "imported-device-owner",
    name: "Imported user",
    email: input.email ?? LOCAL_EMAIL,
    role: input.role ?? "admin",
    autoProvisioned: input.autoProvisioned ?? true,
  });
}

async function rebind() {
  await db.transaction((tx) => rebindLocalUserAfterInstanceRestore(tx));
  const [controller] = await db
    .select()
    .from(schema.instanceController)
    .where(eq(schema.instanceController.id, "local"));
  return controller;
}

describe("local identity after whole-instance recovery", () => {
  it("rebinds a wiped identity without changing installation or controller authority", async () => {
    await destination();
    await importedUser();
    expect(await rebind()).toMatchObject({
      desktopUserId: "imported-device-owner",
      installationId: "destination-installation",
      role: "active",
      handoffId: null,
      revision: 7,
    });
  });

  it.each([
    { role: "receiving" as const, handoffId: "move-one" },
    { role: "active" as const, handoffId: "move-one" },
  ])("leaves a handoff's chosen identity to its protocol (%s)", async ({ role, handoffId }) => {
    await destination(role, handoffId);
    await importedUser();
    expect((await rebind()).desktopUserId).toBe("previous-device-owner");
  });

  it.each([{ role: "user" }, { autoProvisioned: false }, { email: "administrator@example.test" }])(
    "does not substitute an arbitrary imported account (%s)",
    async (input) => {
      await destination();
      await importedUser(input);
      expect((await rebind()).desktopUserId).toBe("previous-device-owner");
    },
  );

  it.each(["admin", "user"])("preserves an existing device identity with role %s", async (role) => {
    await destination();
    await importedUser();
    await db.insert(schema.user).values({
      id: "previous-device-owner",
      name: "Existing user",
      email: "existing@example.test",
      role,
    });
    expect((await rebind()).desktopUserId).toBe("previous-device-owner");
  });
});
