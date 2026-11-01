import {
  RELEASES_LATEST_API,
  SECURITY_FEED_API,
  releaseDocuments,
  updatePollInterval,
  updateRetryAt,
  type ReleaseFeedSnapshot,
  type SecurityManifest,
} from "@repo/core";
import { repos } from "@repo/db";
import { reportCaughtError } from "@repo/core/diagnostics";
import type { ExecutionContext } from "../../../context";
import { tokenFor } from "../github/github.token";
import { verifySecurityManifest } from "./security-signature";

const MAX_BYTES = 1_000_000;
async function readText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES)
    throw new Error("Advisory response is too large.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Advisory response is empty.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.length;
      if (length > MAX_BYTES) throw new Error("Advisory response is too large.");
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {
      // diagnostics-ignore: stream cleanup must not replace the primary read failure.
    });
  }
  return Buffer.concat(chunks).toString("utf8");
}
const readJson = async (response: Response): Promise<unknown> =>
  JSON.parse(await readText(response));

type CachedFeed = NonNullable<Awaited<ReturnType<typeof repos.securityAdvisory.feed>>>;
const pending = new Map<string, Promise<CachedFeed | undefined>>();

/** One cached request per feed and installation, shared across tenants/browsers/projects. Credentials stay on api.github.com. */
async function poll(
  id: "security" | "release",
  token: string | null,
): Promise<CachedFeed | undefined> {
  const running = pending.get(id);
  if (running) return running;
  const task = (async () => {
    const now = new Date(),
      leaseUntil = new Date(now.getTime() + 60_000);
    const row = await repos.securityAdvisory.claimFeed(id, now, leaseUntil);
    if (!row) return repos.securityAdvisory.feed(id);
    let response: Response | undefined;
    let authenticated = !!token;
    try {
      const headers = new Headers({
        Accept:
          id === "security" ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "User-Agent": "Openship-advisor",
        "X-GitHub-Api-Version": "2022-11-28",
      });
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (row.etag) headers.set("If-None-Match", row.etag);
      const url = id === "security" ? SECURITY_FEED_API : RELEASES_LATEST_API;
      response = await fetch(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401 && token) {
        authenticated = false;
        headers.delete("Authorization");
        response = await fetch(url, {
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
      }
      let body = row.body,
        revision = row.revision;
      if (response.status !== 304) {
        if (!response.ok) throw new Error(`GitHub advisory request failed (${response.status}).`);
        const raw = await readJson(response);
        if (id === "security") {
          const manifest = verifySecurityManifest(raw, { minimumRevision: row.revision });
          if (
            manifest.revision === row.revision &&
            row.body &&
            (raw as { payload: string }).payload !== (row.body as { payload: string }).payload
          )
            throw new Error("Advisory revision was reused with different content.");
          revision = manifest.revision;
          body = raw;
        } else {
          const release = raw as { tag_name?: unknown; body?: unknown };
          if (
            typeof release.tag_name !== "string" ||
            !/^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(release.tag_name)
          )
            throw new Error("Invalid GitHub release.");
          // Public raw content never receives the user's credential; both reads are bounded.
          const documents = await releaseDocuments(release.tag_name, (async (
            url: Parameters<typeof fetch>[0],
          ) => {
            const result = await fetch(url, {
              redirect: "error",
              signal: AbortSignal.timeout(10_000),
            });
            return new Response(await readText(result), { status: result.status });
          }) as typeof fetch);
          body = {
            ...documents,
            manifest:
              documents.manifest ?? (row.body as ReleaseFeedSnapshot | null)?.manifest ?? null,
          };
        }
      }
      if (!body) throw new Error("Conditional advisory response has no cached body.");
      if (id === "security") verifySecurityManifest(body, { minimumRevision: revision });
      await repos.securityAdvisory.saveFeed(id, leaseUntil, {
        body,
        revision,
        etag: response.headers.get("etag") ?? (response.status === 304 ? row.etag : null),
        checkedAt: now,
        nextCheckAt: new Date(
          now.getTime() +
            Math.max(
              updatePollInterval(authenticated),
              Math.max(0, Number(response.headers.get("x-poll-interval")) || 0) * 1000,
            ),
        ),
        failures: 0,
        error: null,
        authenticationRejected: !!token && !authenticated,
      });
    } catch (error) {
      reportCaughtError(error, "platform/updates/advisory-feed.poll");
      const failures = row.failures + 1;
      const next = Math.max(
        updateRetryAt(response?.headers ?? new Headers(), now.getTime(), failures),
        now.getTime() + updatePollInterval(authenticated),
      );
      await repos.securityAdvisory.saveFeed(id, leaseUntil, {
        failures,
        nextCheckAt: new Date(next),
        error: error instanceof Error ? error.message.slice(0, 300) : "Advisory check failed.",
      });
    }
    return repos.securityAdvisory.feed(id);
  })();
  pending.set(id, task);
  try {
    return await task;
  } finally {
    pending.delete(id);
  }
}

export interface AdvisoryFeedState {
  release: ReleaseFeedSnapshot;
  security: SecurityManifest | null;
  stale: boolean;
  checkedAt: string | null;
  nextCheckAt: string | null;
  error: string | null;
}

export async function getAdvisoryFeed(ctx?: ExecutionContext): Promise<AdvisoryFeedState> {
  // No credential is persisted in the public cache or returned to clients.
  const token = ctx
    ? await tokenFor(ctx, "local").catch((error) => {
        reportCaughtError(error, "platform/updates/advisory-feed.token");
        return null;
      })
    : null;
  const release = await poll("release", token?.token ?? null);
  const security = await poll("security", token?.token ?? null);
  let manifest: SecurityManifest | null = null;
  try {
    if (security?.body)
      manifest = verifySecurityManifest(security.body, {
        minimumRevision: security.revision,
        allowExpired: true,
      });
  } catch (error) {
    reportCaughtError(error, "platform/updates/advisory-feed.verify-cache");
    /* Invalid cache never authorizes updates. */
  }
  const stale = !manifest || Date.parse(manifest.expiresAt) <= Date.now();
  return {
    release: (release?.body as ReleaseFeedSnapshot | null) ?? { latest: null, manifest: null },
    security: manifest,
    stale,
    checkedAt: security?.checkedAt?.toISOString() ?? null,
    nextCheckAt: security?.nextCheckAt.toISOString() ?? null,
    error: security?.error ?? release?.error ?? null,
  };
}
