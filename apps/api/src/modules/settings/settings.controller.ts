import type { Context } from "hono";
import { getUserId } from "../../lib/controller-helpers";
import { repos } from "@repo/db";
import { randomBytes } from "node:crypto";
import { getBuildMode, type BuildMode } from "./settings.service";

const VALID_MODES: BuildMode[] = ["auto", "server", "local"];

function generateId() {
  return "us_" + randomBytes(12).toString("base64url");
}

/** GET / — return platform settings for the authenticated user */
export async function get(c: Context) {
  const userId = getUserId(c);
  return c.json({ buildMode: await getBuildMode(userId) });
}

/** PUT / — create or update platform settings */
export async function upsert(c: Context) {
  const userId = getUserId(c);
  const body = await c.req.json();

  const buildMode = body.buildMode || "auto";
  if (!VALID_MODES.includes(buildMode)) {
    return c.json({ error: "buildMode must be 'auto', 'server', or 'local'" }, 400);
  }

  const row = await repos.settings.upsert({
    id: generateId(),
    userId,
    buildMode,
  });

  return c.json({ buildMode: row.buildMode });
}

/** PATCH /build-mode — update just the build mode preference */
export async function updateBuildMode(c: Context) {
  const userId = getUserId(c);
  const { buildMode } = await c.req.json();

  if (!VALID_MODES.includes(buildMode)) {
    return c.json({ error: "buildMode must be 'auto', 'server', or 'local'" }, 400);
  }

  const existing = await repos.settings.findByUser(userId);
  if (!existing) {
    await repos.settings.upsert({ id: generateId(), userId, buildMode });
  } else {
    await repos.settings.update(userId, { buildMode });
  }

  return c.json({ buildMode });
}
