#!/usr/bin/env bun
/**
 * End-to-end check of the remote MCP OAuth 2.1 flow against a RUNNING instance.
 *
 * Unit tests cover the pure pieces (resource canonicalization, audience
 * binding). This drives the whole thing the way a spec-strict MCP client does —
 * discovery, dynamic client registration, PKCE authorize, consent, token
 * exchange, and a real `initialize` call — because the failure this was written
 * for ("Authorization with the MCP server failed") only shows up when the hops
 * are wired together behind the real proxy.
 *
 * Usage:
 *   bun scripts/mcp-oauth-check.ts --base https://ops.example.com \
 *     --email you@example.com --password '…'
 *
 * The credentials are an ordinary operator login; consent has to be granted by
 * a real session, so there is no way to run this unattended without one.
 * Exits non-zero on the first failed assertion.
 */

import { createHash, randomBytes } from "node:crypto";

interface Args {
  base: string;
  email: string;
  password: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = get("--base")?.replace(/\/+$/, "");
  const email = get("--email");
  const password = get("--password");
  if (!base || !email || !password) {
    console.error(
      "Usage: bun scripts/mcp-oauth-check.ts --base <url> --email <email> --password <password>",
    );
    process.exit(2);
  }
  return { base, email, password };
}

/* ---------- tiny assertion harness ---------- */

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  checks += 1;
  if (ok) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL  ${name}`);
  if (detail !== undefined) console.error(`        ${JSON.stringify(detail)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

/* ---------- PKCE ---------- */

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1] as string, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/* ---------- flow steps ---------- */

interface RegisteredClient {
  clientId: string;
  redirectUri: string;
}

async function registerClient(base: string): Promise<RegisteredClient> {
  const redirectUri = "http://localhost:7777/callback";
  const res = await fetch(`${base}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: `mcp-oauth-check ${new Date().toISOString()}`,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "openid profile email offline_access",
    }),
  });
  const body = (await res.json()) as { client_id?: string };
  check("DCR registers a public client", res.status === 201 && !!body.client_id, {
    status: res.status,
  });
  if (!body.client_id) process.exit(1);
  return { clientId: body.client_id, redirectUri };
}

async function signIn(base: string, email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookies = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  check("operator sign-in establishes a session", res.status === 200 && cookies.length > 0, {
    status: res.status,
  });
  if (res.status !== 200) process.exit(1);
  return cookies;
}

/**
 * Walk the authorize redirects the way a browser would, stopping at the consent
 * page. Every hop must stay on the PUBLIC origin — a redirect to the internal
 * upstream authority is the bug this whole flow kept dying on.
 */
async function authorizeToConsent(
  base: string,
  cookie: string,
  client: RegisteredClient,
  challenge: string,
  resource: string | null,
): Promise<string> {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: randomBytes(8).toString("hex"),
    scope: "openid profile email offline_access",
  });
  if (resource) params.set("resource", resource);

  let url = `${base}/api/auth/mcp/authorize?${params.toString()}`;
  for (let hop = 0; hop < 8; hop += 1) {
    const res = await fetch(url, { headers: { cookie }, redirect: "manual" });
    if (res.status < 300 || res.status >= 400) {
      check(`authorize hop ${hop} redirects (got ${res.status})`, false, { url });
      process.exit(1);
    }
    const location = res.headers.get("location");
    if (!location) {
      check("authorize redirect carries a Location", false, { url });
      process.exit(1);
    }
    const next = new URL(location, base);
    check(
      `authorize hop ${hop} stays on the public origin`,
      next.origin === new URL(base).origin,
      { location },
    );
    if (next.pathname === "/mcp/authorize") {
      const consentCode = next.searchParams.get("consent_code");
      check("authorize reaches the consent page with a consent_code", !!consentCode, {
        location,
      });
      if (!consentCode) process.exit(1);
      return consentCode;
    }
    if (next.pathname === "/login") {
      check("authorize does not bounce an authenticated session to /login", false, { location });
      process.exit(1);
    }
    url = next.toString();
  }
  check("authorize settles within 8 redirects", false);
  process.exit(1);
}

async function grantConsent(
  base: string,
  cookie: string,
  clientId: string,
  consentCode: string,
): Promise<string> {
  const bind = await fetch(`${base}/api/tokens/mcp-authorize`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ clientId, fullAccess: true, readOnly: false, grants: [] }),
  });
  check("consent records the client's scope binding", bind.status === 200, {
    status: bind.status,
    body: await bind.clone().text(),
  });

  const res = await fetch(`${base}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ accept: true, consent_code: consentCode }),
  });
  const body = (await res.json()) as { redirectURI?: string };
  check("consent returns the client redirect with a code", !!body.redirectURI, {
    status: res.status,
  });
  const code = body.redirectURI ? new URL(body.redirectURI).searchParams.get("code") : null;
  if (!code) process.exit(1);
  return code;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  refresh_token?: string;
  error?: string;
}

async function exchangeCode(
  base: string,
  client: RegisteredClient,
  code: string,
  verifier: string,
  resource: string | null,
): Promise<TokenResponse> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: client.redirectUri,
    client_id: client.clientId,
    code_verifier: verifier,
  });
  if (resource) form.set("resource", resource);

  const started = Date.now();
  const res = await fetch(`${base}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const elapsed = Date.now() - started;
  const body = (await res.json()) as TokenResponse;
  check("token exchange succeeds", res.status === 200 && !!body.access_token, {
    status: res.status,
    body,
  });
  check(`token endpoint answers well under 10s (${elapsed}ms)`, elapsed < 10_000);
  return body;
}

async function callInitialize(base: string, path: string, accessToken: string): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "mcp-oauth-check", version: "1" },
      },
    }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  check(`POST ${path} initialize returns a result`, res.status === 200 && !!body.result, {
    status: res.status,
    body,
  });
}

/* ---------- checks ---------- */

async function checkDiscovery(base: string, canonical: string): Promise<void> {
  section("1. Path-aware protected resource metadata (RFC 9728)");
  const res = await fetch(`${base}/.well-known/oauth-protected-resource/api/mcp`);
  const body = (await res.json()) as { resource?: string; authorization_servers?: string[] };
  check("returns 200", res.status === 200, { status: res.status });
  check("resource is the MCP URL including its path", body.resource === canonical, {
    resource: body.resource,
    expected: canonical,
  });
  check("resource has no trailing slash", !body.resource?.endsWith("/"), body.resource);
  check("authorization_servers points at this origin", body.authorization_servers?.[0] === base, {
    authorization_servers: body.authorization_servers,
  });

  const proxied = await fetch(`${base}/.well-known/oauth-protected-resource/api/proxy/api/mcp`);
  const proxiedBody = (await proxied.json()) as { resource?: string };
  check("the /api/proxy alias has its own document", proxied.status === 200, {
    status: proxied.status,
  });
  check(
    "the alias document names the alias URL",
    proxiedBody.resource === `${base}/api/proxy/api/mcp`,
    proxiedBody,
  );
}

async function checkChallenge(base: string): Promise<void> {
  section("2. 401 challenge on the MCP endpoint");
  const res = await fetch(`${base}/api/mcp`, { redirect: "manual" });
  check("unauthenticated GET is 401, not a redirect", res.status === 401, {
    status: res.status,
    location: res.headers.get("location"),
  });
  const header = res.headers.get("www-authenticate") ?? "";
  check(
    "WWW-Authenticate points at the path-aware metadata",
    header.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/api/mcp"`),
    header,
  );

  const post = await fetch(`${base}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    redirect: "manual",
  });
  check("unauthenticated POST is 401 with the same pointer", post.status === 401, {
    status: post.status,
  });
  check(
    "no 3xx on the MCP endpoint (Claude drops Authorization across redirects)",
    post.status < 300 || post.status >= 400,
    post.status,
  );
}

async function checkInvalidTarget(base: string, client: RegisteredClient): Promise<void> {
  section("3. Unknown resource is rejected with invalid_target");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    code_challenge: pkce().challenge,
    code_challenge_method: "S256",
    resource: "https://not-this-server.example.com/api/mcp",
  });
  const res = await fetch(`${base}/api/auth/mcp/authorize?${params}`, { redirect: "manual" });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  check("authorize rejects a foreign resource", res.status === 400, { status: res.status });
  check("…with error=invalid_target", body.error === "invalid_target", body);
}

async function runFlow(
  base: string,
  cookie: string,
  canonical: string,
  resource: string | null,
): Promise<void> {
  const client = await registerClient(base);
  const { verifier, challenge } = pkce();
  const consentCode = await authorizeToConsent(base, cookie, client, challenge, resource);
  const code = await grantConsent(base, cookie, client.clientId, consentCode);
  const token = await exchangeCode(base, client, code, verifier, resource);
  if (!token.access_token) return;

  check("token_type is Bearer", token.token_type?.toLowerCase() === "bearer", token.token_type);

  const payload = decodeJwtPayload(token.access_token);
  check("access token is a decodable JWT", !!payload, token.access_token.slice(0, 24));
  check("aud is the requested resource", payload?.aud === (resource ?? canonical), {
    aud: payload?.aud,
    expected: resource ?? canonical,
  });
  check("iss is this instance", payload?.iss === base, { iss: payload?.iss });

  await callInitialize(base, "/api/mcp", token.access_token);
  await callInitialize(base, "/api/proxy/api/mcp", token.access_token);
}

async function main(): Promise<void> {
  const { base, email, password } = parseArgs(process.argv.slice(2));
  const canonical = `${base}/api/mcp`;
  console.log(`Checking ${base} (canonical MCP resource: ${canonical})`);

  await checkDiscovery(base, canonical);
  await checkChallenge(base);

  const cookie = await signIn(base, email, password);
  await checkInvalidTarget(base, await registerClient(base));

  section("4. Full flow WITH the RFC 8707 resource parameter");
  await runFlow(base, cookie, canonical, canonical);

  section("5. Regression: the same flow with NO resource parameter");
  await runFlow(base, cookie, canonical, null);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
