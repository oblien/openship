import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeSpec } from "../../../src/modules/route-rules/route-rule.controller";

/**
 * The TS side stores a `RouteRuleSpec` and pushes it into a shared dict; `rules_lib.lua`
 * decodes it and `rules_guard.lua` enforces it. Nothing type-checks across that gap: a
 * renamed field, or a section added on one side only, produces a rule that saves, shows
 * in the UI, pushes successfully — and enforces nothing.
 *
 * There is no Lua runtime in CI (the guard needs `ngx.*`, `resty.lrucache` and a real
 * request), so this asserts the contract against the Lua SOURCE, the same way
 * `lua-embedded.test.ts` and `edge-shared-dicts.test.ts` do. It covers the two things
 * that silently rot — the field names, and the security properties the comments in
 * those files promise.
 */

const LUA_DIR = new URL("../../../../../packages/adapters/src/infra/lua/", import.meta.url);
const lib = readFileSync(new URL("rules_lib.lua", LUA_DIR), "utf8");
const guard = readFileSync(new URL("rules_guard.lua", LUA_DIR), "utf8");
const mgmt = readFileSync(new URL("mgmt_api.lua", LUA_DIR), "utf8");

/** A spec exercising every section the sanitizer will keep — the full wire shape. */
const FULL = sanitizeSpec({
  rateLimit: { rps: 10, burst: 20, status: 429 },
  ban: {
    ips: ["1.2.3.4"],
    cidrs: ["10.0.0.0/8"],
    countries: ["RU"],
    userAgents: ["badbot"],
    emptyUserAgent: true,
  },
  access: {
    allowCidrs: ["10.0.0.0/8"],
    denyCidrs: ["1.2.3.4"],
    allowCountries: ["DE"],
    methods: ["GET"],
  },
  hotlink: { allowReferers: ["a.com"], allowEmpty: false },
  block: { status: 451 },
});

/** Lua local name → the spec section it holds, as `rules_lib.compile_spec` binds them. */
const SECTION_LOCALS: Record<string, string> = {
  rl: "rateLimit",
  ban: "ban",
  acc: "access",
  hot: "hotlink",
};

/** Field names read off `<local>.` in the Lua source. */
function readsOf(local: string): Set<string> {
  return new Set(
    [...lib.matchAll(new RegExp(`\\b${local}\\.([A-Za-z_][A-Za-z0-9_]*)`, "g"))].map((m) => m[1]!),
  );
}

describe("rules_lib.lua reads every field the API emits", () => {
  it("handles every top-level section of the spec", () => {
    const sections = new Set(
      [...lib.matchAll(/\bspec\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!),
    );
    for (const key of Object.keys(FULL)) {
      expect(sections, `rules_lib.lua ignores spec.${key}`).toContain(key);
    }
  });

  it("reads every field inside each section", () => {
    for (const [local, section] of Object.entries(SECTION_LOCALS)) {
      const reads = readsOf(local);
      const emitted = Object.keys(FULL[section as keyof typeof FULL] as object).filter(
        (k) => k !== "key", // rateLimit.key is pinned to "ip"; the guard's key is fixed
      );
      for (const field of emitted) {
        expect(reads, `rules_lib.lua ignores ${section}.${field} (read as ${local}.${field})`)
          .toContain(field);
      }
    }
  });

  it("reads the block status and the path prefix", () => {
    expect(lib).toContain("spec.block.status");
    expect(lib).toContain("e.pathPrefix"); // the per-entry prefix the guard matches on
  });

  it("reads nothing the API never sends (a dead branch is spec drift)", () => {
    // The reverse direction: a field the guard expects but nothing emits means the
    // rename happened on one side only.
    const known: Record<string, string[]> = {
      rl: ["rps", "burst", "status"],
      ban: ["ips", "cidrs", "countries", "userAgents", "emptyUserAgent"],
      acc: ["allowCidrs", "denyCidrs", "allowCountries", "methods"],
      hot: ["allowReferers", "allowEmpty"],
    };
    for (const [local, section] of Object.entries(SECTION_LOCALS)) {
      const emitted = new Set(Object.keys(FULL[section as keyof typeof FULL] as object));
      // `known` is the declared read-set; it must match the Lua source AND the API.
      expect([...readsOf(local)].sort(), `${local}.* reads changed`).toEqual(
        known[local]!.slice().sort(),
      );
      for (const field of known[local]!) {
        if (field === "key") continue;
        expect(emitted, `${section}.${field} is read by Lua but never sent`).toContain(field);
      }
    }
  });
});

describe("mgmt_api.lua accepts what pushProjectRules sends", () => {
  const handler = mgmt.slice(mgmt.indexOf('if uri == "/rules"'));

  it("takes the { host, rules } body the pusher posts", () => {
    // `pushHost` posts exactly this; a rename on either side pushes 400s that only
    // surface as a console warning.
    expect(handler).toContain("payload.host");
    expect(handler).toContain("payload.rules");
  });

  it("treats an empty rules array as CLEAR, which is how a deletion propagates", () => {
    // pushProjectRules pushes every current host, with `[]` for hosts that have no
    // rules left. If that stored an empty ruleset instead of deleting the key, the
    // guard would keep taking the slow path for every request to that host.
    const post = handler.slice(handler.indexOf('if method == "POST"'));
    expect(post).toContain("#list == 0");
    expect(post).toContain("rules:delete(host)");
  });

  it("keys the dict by lowercased host, the same as the guard's lookup", () => {
    // The guard reads `rules:get(ngx.var.host)` with no normalization, so the write
    // side has to be the one that lowercases — and the serializer does it too.
    expect(handler).toContain("tostring(payload.host):lower()");
    expect(guard).toContain("local host = ngx.var.host");
    expect(guard).toContain("rules:get(host)");
  });

  it("declares the two dicts the rules path needs", () => {
    expect(mgmt).toContain('"rules", "rl_counters"');
  });
});

describe("rules_lib.lua treats rule values as data, never code", () => {
  it("never turns a rule value into Lua", () => {
    for (const src of [lib, guard]) {
      expect(src).not.toMatch(/\bloadstring\b/);
      expect(src).not.toMatch(/\bload\s*\(/);
      expect(src).not.toMatch(/\bos\.execute\b/);
      expect(src).not.toMatch(/\bio\.popen\b/);
    }
  });

  it("matches user-agents PLAINLY, so a needle can't be a Lua pattern", () => {
    // `string.find(hay, needle)` without the plain flag makes every rule value a
    // pattern: `%` or `.` in a UA string would change what it matches, and a
    // pathological one is a CPU sink on the request path.
    const finds = [...guard.matchAll(/string\.find\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(finds.length).toBeGreaterThan(0);
    for (const args of finds) {
      expect(args.replace(/\s/g, ""), `string.find(${args}) is not a plain match`).toMatch(
        /,1,true$/,
      );
    }
  });

  it("compares countries and methods by set lookup, not by pattern", () => {
    expect(lib).toContain("to_set(ban.countries)");
    expect(lib).toContain("to_set(acc.methods)");
    expect(guard).toContain("access.methods[ngx.req.get_method()]");
  });
});

describe("rules_guard.lua keeps the properties its comments promise", () => {
  it("fails CLOSED when a country ban is active but geo is unavailable", () => {
    // Fail-open here is a silent security hole: the operator sees an active country
    // ban and banned traffic sails through.
    const banBlock = guard.slice(guard.indexOf("local ban = spec.ban"));
    const countryBranch = banBlock.slice(
      banBlock.indexOf("if ban.countries"),
      banBlock.indexOf("if ban.emptyUA"),
    );
    expect(countryBranch).toContain("if not cc then");
    expect(countryBranch).toContain("fail-closed");
    // The block must happen INSIDE the unresolved-country branch.
    const unresolved = countryBranch.slice(countryBranch.indexOf("if not cc then"));
    expect(unresolved.slice(0, unresolved.indexOf("end"))).toContain("ngx.exit(deny_status)");
  });

  it("treats an unresolved country as off a country ALLOW-list (default-deny)", () => {
    expect(guard).toContain('access.allowCountries[country_of() or ""]');
  });

  it("resolves geo at most once per request, and only when a rule needs it", () => {
    // `country_of()` is memoized (including the negative result) because the lookup
    // is the most expensive thing on this path.
    expect(guard).toContain("if country_cache == nil then");
    expect(guard).toContain("country_cache or nil");
    expect(guard).toContain("pcall(require, \"openship.geo_country\")");
  });

  it("returns early when the host has no rules (the common case)", () => {
    const head = guard.slice(0, guard.indexOf("local lib ="));
    expect(head).toContain("if not raw then return end");
  });

  it("picks the longest matching path prefix", () => {
    expect(guard).toContain("if #p > chosen_len then");
    // A prefix-less rule is the fallback, not a competitor for longest match.
    expect(guard).toContain("if chosen_len < 0 then");
  });

  it("counts rate limits in their OWN dict, falling back on an older box", () => {
    // A flood creates one counter key per IP per second; sharing the dict with the
    // rulesets would let it LRU-evict them and silently disable enforcement.
    expect(guard).toContain("ngx.shared.rl_counters or rules");
    expect(guard).toMatch(/counters:incr\([^)]*\)/);
  });

  it("keys the rate limit by host, path and client IP in a self-expiring bucket", () => {
    expect(guard).toContain('"rl:" .. host .. ":" .. (chosen.pathPrefix or "/") .. ":" .. ips');
    expect(guard).toContain("math.floor(ngx.now())");
    expect(guard).toMatch(/counters:incr\(key, 1, 0, 2\)/); // 2s TTL, no sweeper needed
  });

  it("enforces on the connecting peer, not a client-supplied header", () => {
    // Trusting X-Forwarded-For here would make every limit and ban spoofable; a
    // real_ip config in front is what rewrites remote_addr.
    expect(guard).toContain("ngx.var.remote_addr");
    expect(guard).not.toContain("http_x_forwarded_for");
  });

  it("never writes a rule value into a response header", () => {
    const headerWrites = [...guard.matchAll(/ngx\.header\[[^\]]+\]\s*=\s*(.+)/g)].map((m) => m[1]!);
    expect(headerWrites).toEqual(['"1"']); // Retry-After only, a literal
  });

  it("applies access before ban before hotlink before rate limit", () => {
    // Order matters for what a blocked request costs us: the cheap allow/deny checks
    // run before geo, and the shared-dict write runs last.
    const at = (needle: string) => guard.indexOf(needle);
    expect(at("local access = spec.access")).toBeLessThan(at("local ban = spec.ban"));
    expect(at("local ban = spec.ban")).toBeLessThan(at("local hot = spec.hotlink"));
    expect(at("local hot = spec.hotlink")).toBeLessThan(at("local rl = spec.rl"));
  });
});
