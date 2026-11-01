import { pbkdf2, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { AppError } from "@repo/core";

const derive = promisify(pbkdf2);

/** Private edge configuration. Never serialize this through a public read API. */
export interface RouteProtection {
  version: string;
  salt: string;
  verifier: string;
  signingKey: string;
  iterations: 600_000;
  sessionSeconds: number;
}

export async function createRouteProtection(
  password: string,
  sessionSeconds = 86_400,
): Promise<RouteProtection> {
  if (
    typeof password !== "string" ||
    Buffer.byteLength(password) < 12 ||
    Buffer.byteLength(password) > 256
  ) {
    throw new AppError(
      "Use a route password between 12 and 256 UTF-8 bytes.",
      400,
      "INVALID_ROUTE_PASSWORD",
    );
  }
  const salt = randomBytes(32);
  const policy: RouteProtection = {
    version: randomBytes(16).toString("hex"),
    salt: salt.toString("hex"),
    verifier: (await derive(password, salt, 600_000, 32, "sha256")).toString("hex"),
    signingKey: randomBytes(32).toString("hex"),
    iterations: 600_000,
    sessionSeconds,
  };
  assertRouteProtection(policy);
  return policy;
}

export function revokeRouteSessions(policy: RouteProtection): RouteProtection {
  assertRouteProtection(policy);
  return {
    ...policy,
    version: randomBytes(16).toString("hex"),
    signingKey: randomBytes(32).toString("hex"),
  };
}

export function assertRouteProtection(value: unknown): asserts value is RouteProtection {
  const policy = value as RouteProtection | null;
  if (
    !policy ||
    !/^[a-f0-9]{32}$/.test(policy.version) ||
    ![policy.salt, policy.verifier, policy.signingKey].every(
      (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v),
    ) ||
    policy.iterations !== 600_000 ||
    !Number.isInteger(policy.sessionSeconds) ||
    policy.sessionSeconds < 300 ||
    policy.sessionSeconds > 604_800
  )
    throw new Error("Invalid route protection configuration.");
}

export const ROUTE_AUTH_PATH = "/_openship/access";
export const ROUTE_AUTH_THREAD_POOL = "thread_pool openship_password threads=2 max_queue=8;";
export const ROUTE_AUTH_VM_POOL = "lua_worker_thread_vm_pool_size 2;";
// Unlike ngx.ctx or `set`, this writable request variable survives internal redirects.
export const ROUTE_AUTH_STATE = 'map "" $openship_route_authorized { default ""; }';

/** Upgrade a legacy bare edge inside the caller's config transaction. */
export function withRouteProtectionRuntime(config: string): string {
  if (!/^\s*http\s*\{/m.test(config))
    throw new Error("Cannot configure route protection: nginx http block is missing.");
  const directives = [
    [/\blua_worker_thread_vm_pool_size\b/, ROUTE_AUTH_VM_POOL],
    [/\$openship_route_authorized\b/, ROUTE_AUTH_STATE],
    [/\blua_shared_dict\s+route_auth_limits\b/, "lua_shared_dict route_auth_limits 1m;"],
  ] as const;
  for (const [pattern, directive] of directives) {
    if (!pattern.test(config)) config = config.replace(/^(\s*http\s*\{)/m, `$1\n    ${directive}`);
  }
  if (!/^\s*thread_pool\s+openship_password\s/m.test(config))
    config = ROUTE_AUTH_THREAD_POOL + "\n" + config;
  return config;
}

/** Safe literal: base64 contains no nginx variable, quote or directive delimiters. */
export function renderRouteProtection(policy: RouteProtection): string {
  assertRouteProtection(policy);
  const encoded = Buffer.from(JSON.stringify(policy)).toString("base64");
  return `    set $openship_route_auth $openship_route_auth;
    # Index the map variable for Lua writes, preserving it on internal redirects.
    set $openship_route_authorized $openship_route_authorized;
    # Server Lua runs before nginx set/return; initialize policy here so redirects
    # and content handlers are both gated.
    server_rewrite_by_lua_block {
        ngx.var.openship_route_auth = '${encoded}'
        require("openship.route_auth").guard()
    }
    header_filter_by_lua_file /usr/local/openresty/site/lualib/openship/route_auth_headers.lua;

    location = ${ROUTE_AUTH_PATH} {
        client_max_body_size 4k;
        client_body_buffer_size 4k;
        content_by_lua_file /usr/local/openresty/site/lualib/openship/route_auth_login.lua;
    }
`;
}
