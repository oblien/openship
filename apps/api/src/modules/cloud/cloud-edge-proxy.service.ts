/**
 * Cloud edge proxy service - sync a namespaced edge proxy on Oblien.
 *
 * Extracted from cloud-saas.controller so slug normalization +
 * hostname construction stay in one place and are unit-testable
 * independent of the HTTP layer.
 */

import { SYSTEM } from "@repo/core";
import { isCloudEdgeHost } from "../../lib/edge-target";
import { getNamespaceClient } from "../../lib/openship-cloud";

/** Canonicalize a slug the same way for sync and delete so both look up the
 *  SAME Oblien proxy (a mismatch here would orphan the route on teardown). */
function normalizeEdgeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export async function syncCloudEdgeProxy(
  organizationId: string,
  input: { slug: string; target: string },
): Promise<{ ok: true; hostname: string } | { ok: false; status: 400; error: string }> {
  const slug = normalizeEdgeSlug(input.slug);
  if (!slug) {
    return { ok: false, status: 400, error: "Invalid slug" };
  }

  const baseDomain = SYSTEM.DOMAINS.CLOUD_DOMAIN;
  const hostname = `${slug}.${baseDomain}`;

  // Last hop before Oblien, so it's also the last chance to catch a self-referential
  // target: a `*.opsh.io` target makes the edge forward the request back into itself.
  // The senders are guarded (resolveEdgeTargetHost), but this is the ONE place every
  // self-hosted box funnels through — so an older, unpatched box gets caught here
  // instead of silently registering a route that spins.
  if (isCloudEdgeHost(input.target)) {
    return {
      ok: false,
      status: 400,
      error:
        `"${input.target}" is an Openship Cloud edge address, so routing ${hostname} there ` +
        `would loop back to the edge. Send the server's own public IP or hostname.`,
    };
  }

  const target =
    input.target.startsWith("http://") || input.target.startsWith("https://")
      ? input.target
      : `http://${input.target}`;

  const { client, namespace } = await getNamespaceClient(organizationId);

  // Namespace isolation: Oblien scopes edgeProxy.list/update/enable to
  // the namespace token's owner, so the look-up-by-slug + mutate path
  // can't cross orgs. The `create` call additionally passes `namespace`
  // explicitly so Oblien validates the new resource lands in the
  // expected namespace — non-create methods (list/update/enable/disable
  // /delete) identify by id and don't accept a namespace param.
  const { proxies } = await client.edgeProxy.list();
  const existing = proxies.find((p) => p.slug === slug);

  if (!existing) {
    await client.edgeProxy.create({ name: hostname, slug, domain: baseDomain, target, namespace });
    // A freshly created proxy is NOT assumed active. The update path below
    // explicitly enables a `disabled` proxy, which means Oblien can hold one in
    // that state — and a created-but-disabled proxy is indistinguishable from
    // success here: we return ok, the slug reads as taken on the next attempt, and
    // `<slug>.opsh.io` resolves to the zone wildcard with no origin (Cloudflare
    // error 1000). Re-read and enable so "synced" means "serving".
    const created = (await client.edgeProxy.list()).proxies.find((p) => p.slug === slug);
    if (created?.status === "disabled") await client.edgeProxy.enable(created.id);
  } else {
    if (
      existing.name !== hostname ||
      existing.slug !== slug ||
      existing.target !== target
    ) {
      await client.edgeProxy.update(existing.id, { name: hostname, slug, target });
    }
    if (existing.status === "disabled") {
      await client.edgeProxy.enable(existing.id);
    }
  }

  return { ok: true, hostname };
}

/**
 * Tear down a namespaced edge proxy on Oblien for a freed slug.
 *
 * Mirror of syncCloudEdgeProxy for the delete side (dropping a free *.opsh.io
 * domain). Namespace-scoped `list` finds the proxy this org owns, then
 * `delete(id)` removes it — same namespace-isolation guarantee as sync (the
 * caller can only ever see/delete its own proxies). Idempotent: an absent slug
 * returns `removed:false` with no error so a redundant teardown is a no-op.
 */
export async function deleteCloudEdgeProxy(
  organizationId: string,
  input: { slug: string },
): Promise<{ ok: true; removed: boolean } | { ok: false; status: 400; error: string }> {
  const slug = normalizeEdgeSlug(input.slug);
  if (!slug) {
    return { ok: false, status: 400, error: "Invalid slug" };
  }

  const { client } = await getNamespaceClient(organizationId);
  const { proxies } = await client.edgeProxy.list();
  const existing = proxies.find((p) => p.slug === slug);
  if (!existing) {
    return { ok: true, removed: false };
  }
  await client.edgeProxy.delete(existing.id);
  return { ok: true, removed: true };
}
