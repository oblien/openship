import { Hono, type Context } from "hono";
import { actionStorageProtocol } from "@repo/platform/engine/modules/actions/storage";
import { secureRouter } from "../../lib/secure-router";
import { handleApiError } from "../../middleware/error-handler";

const spec = {
  reason:
    "Authenticates an expiring, purpose-bound Actions job capability and rechecks the saved actor and organization; user sessions and provider keys are not accepted.",
  rateLimit: "actions-runtime" as const,
};
async function handle(c: Context) {
  try {
    return await actionStorageProtocol().handle(c.req.raw);
  } catch (error) {
    const response = handleApiError(error, c);
    if (!c.req.path.includes("/twirp/")) return response;
    const value = (await response.json()) as { error: string };
    const codes: Record<number, string> = {
      400: "invalid_argument",
      401: "unauthenticated",
      403: "permission_denied",
      404: "not_found",
      409: "failed_precondition",
      413: "resource_exhausted",
      429: "resource_exhausted",
      503: "unavailable",
    };
    return Response.json(
      { code: codes[response.status] ?? "internal", msg: value.error },
      { status: response.status, headers: response.headers },
    );
  }
}

const protocols = new Map<string, Hono>();
for (const basePath of ["/api/actions/runtime/twirp", "/twirp"] as const) {
  const r = secureRouter(new Hono(), { module: "actions-runtime", basePath });
  for (const [service, methods] of [
    [
      "github.actions.results.api.v1.ArtifactService",
      [
        "CreateArtifact",
        "FinalizeArtifact",
        "ListArtifacts",
        "GetSignedArtifactURL",
        "DeleteArtifact",
      ],
    ],
    [
      "github.actions.results.api.v1.CacheService",
      ["CreateCacheEntry", "FinalizeCacheEntryUpload", "GetCacheEntryDownloadURL"],
    ],
  ] as const)
    for (const method of methods) r.public("post", `/${service}/${method}`, spec, handle);
  protocols.set(basePath, r.hono);
}

const r = secureRouter(new Hono(), { module: "actions-runtime", basePath: "/api/actions/runtime" });
r.public("get", "/objects/:id", spec, handle);
r.public("put", "/objects/:id", spec, handle);
r.public("get", "/_apis/artifactcache/cache", spec, handle);
r.public("post", "/_apis/artifactcache/caches", spec, handle);
r.public("patch", "/_apis/artifactcache/caches/:id", spec, handle);
r.public("post", "/_apis/artifactcache/caches/:id", spec, handle);
r.hono.route("/twirp", protocols.get("/api/actions/runtime/twirp")!);
export const actionRuntimeRoutes = r.hono;
// @actions/cache resolves /twirp from the origin, discarding any base path.
export const actionTwirpRoutes = protocols.get("/twirp")!;
