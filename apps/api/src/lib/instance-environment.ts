import { db, schema } from "@repo/db";
import { createEncryption, DEFAULT_ENCRYPTION_SECRET } from "@repo/db/encryption";
import { instanceEnvironment, INSTANCE_ENVIRONMENT_KEYS } from "@repo/core";

/** Do not import the engine's env module here: its validation and derived OAuth
 * configuration must run AFTER the transferred configuration has been loaded. */
export async function loadInstanceEnvironment(): Promise<void> {
  if (["true", "1"].includes(process.env.CLOUD_MODE ?? "")) return;
  const [state] = await db
    .select({ environment: schema.instanceController.environment })
    .from(schema.instanceController)
    .limit(1);
  if (!state?.environment) return;
  const cipher = createEncryption(process.env.BETTER_AUTH_SECRET ?? DEFAULT_ENCRYPTION_SECRET);
  try {
    const saved = instanceEnvironment(JSON.parse(cipher.decrypt(state.environment)));
    for (const key of INSTANCE_ENVIRONMENT_KEYS) {
      if (saved[key]) process.env[key] = saved[key];
      else delete process.env[key];
    }
  } finally {
    cipher.close();
  }
}
