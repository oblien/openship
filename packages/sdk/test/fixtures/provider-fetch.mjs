// Test-only provider boundary for the real native worker. Keep platform
// operations, encryption, authorization and persistence unchanged.
import { workerData } from "node:worker_threads";

const networkFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === "https://api.openship.io") {
    const plans = workerData.testCloudPlans;
    if (
      request.method !== "GET" ||
      url.pathname !== "/api/billing/plans" ||
      !plans ||
      url.searchParams.get("locale") !== plans.locale ||
      request.headers.has("authorization") ||
      request.headers.has("cookie")
    ) {
      throw new Error(`Unexpected Cloud fixture request: ${request.method} ${url.pathname}`);
    }
    return Response.json({ data: plans });
  }
  if (url.origin !== "https://api.github.com") return networkFetch(input, init);
  if (request.method !== "GET" || url.pathname !== "/user") {
    throw new Error(`Unexpected GitHub fixture request: ${request.method} ${url.pathname}`);
  }
  if (request.headers.get("authorization") !== "Bearer persistent-private-token") {
    return Response.json({ message: "Bad credentials" }, { status: 401 });
  }
  return Response.json(
    { login: "alice", id: 1, avatar_url: "" },
    { headers: { "x-oauth-scopes": "repo" } },
  );
};
