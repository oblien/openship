/**
 * `openship token` — personal access tokens.
 *
 * Grounded in apps/api/src/modules/tokens/token.routes.ts (mounted at
 * /api/tokens). Self-scoped: every call operates on the caller's own tokens.
 *   list    GET    /tokens                 → { data: PublicToken[] }
 *   create  POST   /tokens                 { name, readOnly?, expiresInDays?, grants?, fullAccess? }
 *                                          → 201 { data: { ...token, token } }  (plaintext ONCE)
 *                                          Exactly one of grants / fullAccess:true is required —
 *                                          the API will not infer "no limits" from an empty list.
 *   revoke  DELETE /tokens/:id             → { data: { revoked: true } }
 */
import { Command } from "commander";
import chalk from "chalk";
import { apiRequest } from "../lib/api-client";
import { printJson, printTable, isJsonMode, ok, info } from "../lib/output";
import { spin, fail } from "../lib/cmd-helpers";

interface TokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  readOnly: boolean;
  scoped: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface Grant {
  resourceType: string;
  resourceId: string;
  permissions: string[];
}

/** Parse a repeatable `--grant type:id:perm1,perm2` into the API's grant shape. */
function collectGrant(value: string, acc: Grant[]): Grant[] {
  const [resourceType, resourceId, permsRaw] = value.split(":");
  if (!resourceType || !resourceId || !permsRaw) {
    throw new Error(`Invalid --grant "${value}". Expected type:id:perm1,perm2`);
  }
  const permissions = permsRaw.split(",").map((p) => p.trim()).filter(Boolean);
  acc.push({ resourceType, resourceId, permissions });
  return acc;
}

const listCmd = new Command("list")
  .description("List your personal access tokens")
  .action(async () => {
    try {
      const res = await apiRequest<{ data: TokenRow[] }>("/tokens");
      const rows = res.data ?? [];
      if (isJsonMode()) {
        printJson(rows);
        return;
      }
      printTable(
        rows.map((t) => ({
          id: t.id,
          name: t.name,
          prefix: t.tokenPrefix,
          readOnly: t.readOnly ? "yes" : "",
          scoped: t.scoped ? "yes" : "",
          expires: t.expiresAt ?? "never",
          lastUsed: t.lastUsedAt ?? "never",
          revoked: t.revokedAt ? "yes" : "",
        })),
        ["id", "name", "prefix", "readOnly", "scoped", "expires", "lastUsed", "revoked"],
      );
    } catch (e) {
      fail(e);
    }
  });

const createCmd = new Command("create")
  .description("Mint a new personal access token (the secret is shown once)")
  .argument("<name>", "Human-readable token name")
  .option("--read-only", "Reject mutation methods (POST/PUT/PATCH/DELETE)", false)
  .option("--expires <days>", "Expire after N days (1–365); omit for non-expiring", (v) => parseInt(v, 10))
  .option(
    "--grant <type:id:perms>",
    "Scope the token to a resource (repeatable), e.g. project:abc123:read,write",
    collectGrant,
    [] as Grant[],
  )
  .option(
    "--full-access",
    "Mint an UNSCOPED token with your own full access (required when no --grant is given)",
    false,
  )
  .action(async (name: string, opts) => {
    const grants: Grant[] = opts.grant ?? [];
    // The API refuses to infer "no limits" from an absent --grant, so say it here
    // rather than letting the user meet a 400. Checked locally so the message can
    // name the flags instead of the wire fields.
    if (grants.length === 0 && !opts.fullAccess) {
      fail(
        new Error(
          "Refusing to mint an unscoped token by default. Pass --grant <type:id:perms> to scope " +
            "it, or --full-access to deliberately create one with your own full access.",
        ),
      );
    }
    if (grants.length > 0 && opts.fullAccess) {
      fail(new Error("--grant and --full-access are mutually exclusive: pick one."));
    }
    const body = {
      name,
      readOnly: opts.readOnly || undefined,
      expiresInDays: Number.isFinite(opts.expires) ? opts.expires : undefined,
      grants: grants.length > 0 ? grants : undefined,
      fullAccess: grants.length === 0 ? true : undefined,
    };
    const sp = spin(`Creating token "${name}"…`);
    try {
      const res = await apiRequest<{ data: TokenRow & { token: string } }>("/tokens", {
        method: "POST",
        body: JSON.stringify(body),
      });
      sp?.succeed(`Created token "${res.data.name}"`);
      if (isJsonMode()) {
        printJson(res.data);
        return;
      }
      info("  Copy this token now — it will not be shown again:");
      process.stdout.write(chalk.cyan(`  ${res.data.token}\n`));
    } catch (e) {
      sp?.fail("Create failed");
      fail(e);
    }
  });

const revokeCmd = new Command("revoke")
  .description("Revoke one of your tokens")
  .argument("<id>", "Token ID")
  .action(async (id: string) => {
    const sp = spin("Revoking token…");
    try {
      await apiRequest(`/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
      sp?.succeed(`Revoked ${id}`);
      if (isJsonMode()) printJson({ id, revoked: true });
      else ok(`  Token ${id} revoked`);
    } catch (e) {
      sp?.fail("Revoke failed");
      fail(e);
    }
  });

export const tokenCommand = new Command("token")
  .description("Manage personal access tokens")
  .addCommand(listCmd)
  .addCommand(createCmd)
  .addCommand(revokeCmd);
