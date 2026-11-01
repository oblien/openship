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
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { isCapability } from "@repo/core";
import { Command } from "commander";
import chalk from "chalk";
import { getShipClient } from "../lib/ship-client";
import { printJson, printTable, isJsonMode, ok, info } from "../lib/output";
import { spin, fail } from "../lib/cmd-helpers";
import { positiveInteger } from "../lib/command-input";
import { TokenCollectionSchemas } from "@repo/contracts";
import { confirmOrExit, printResult } from "../lib/cmd-helpers";
import { jsonCommand } from "../lib/json-command";

import type { TCreateTokenBody } from "@repo/sdk";
type Grant = NonNullable<TCreateTokenBody["grants"]>[number];

/**
 * Parse a repeatable `--grant type:id:perm1,perm2` into the API's grant shape.
 * Permissions are levels (read, write, admin, create) or capabilities, which carry
 * their own colon (`project:proj_1:domains:read,domains:delete`).
 */
export function collectGrant(value: string, acc: Grant[]): Grant[] {
  const [resourceType, resourceId, ...rest] = value.split(":");
  const permsRaw = rest.join(":");
  if (!resourceType || !resourceId || !permsRaw) {
    throw new Error(`Invalid --grant "${value}". Expected type:id:perm1,perm2`);
  }
  const permissions = permsRaw.split(",").map((p) => p.trim()).filter(Boolean);
  if (permissions.some(p => !["read", "write", "admin", "create"].includes(p) && !isCapability(p)))
    throw new Error(`Invalid permission in --grant "${value}"`);
  return [...acc, { resourceType, resourceId, permissions: permissions as Grant["permissions"] }];
}

const listCmd = new Command("list")
  .description("List your personal access tokens")
  .action(async () => {
    try {
      const rows = await getShipClient().tokens.list();
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
      observeCaughtError(e, "cli/commands/token");
      fail(e);
    }
  });

const createCmd = new Command("create")
  .description("Mint a new personal access token (the secret is shown once)")
  .argument("<name>", "Human-readable token name")
  .option("--read-only", "Reject mutation methods (POST/PUT/PATCH/DELETE)", false)
  .option("--expires <days>", "Expire after N days (1–365); omit for non-expiring", positiveInteger)
  .option(
    "--grant <type:id:perms>",
    "Scope the token to a resource (repeatable), e.g. project:abc123:read,write or project:abc123:domains:read,domains:write,domains:delete",
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
      const result = await getShipClient().tokens.create(body);
      sp?.succeed(`Created token "${result.name}"`);
      if (isJsonMode()) {
        printJson(result);
        return;
      }
      info("  Copy this token now — it will not be shown again:");
      process.stdout.write(chalk.cyan(`  ${result.token}\n`));
    } catch (e) {
      observeCaughtError(e, "cli/commands/token");
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
      await getShipClient().tokens.revoke(id);
      sp?.succeed(`Revoked ${id}`);
      if (isJsonMode()) printJson({ id, revoked: true });
      else ok(`  Token ${id} revoked`);
    } catch (e) {
      observeCaughtError(e, "cli/commands/token");
      sp?.fail("Revoke failed");
      fail(e);
    }
  });

export const tokenCommand = new Command("token")
  .description("Manage personal access tokens")
  .addCommand(listCmd)
  .addCommand(createCmd)
  .addCommand(revokeCmd);

const mcp = new Command("mcp").description("Inspect and revoke MCP clients authorized by your account");
mcp.command("list").description("List authorized MCP clients and their resource scopes")
  .action(() => printResult(() => getShipClient().tokens.listMcpClients()));
mcp.command("get").argument("<id>", "MCP client ID").description("Inspect this client's permissions")
  .action((id: string) => printResult(() => getShipClient().tokens.getMcpClient(id)));
jsonCommand(mcp.command("authorize").description("Authorize an MCP client with explicit resource grants or full access"),
  TokenCollectionSchemas.authorizeMcpClient.input, input => getShipClient().tokens.authorizeMcpClient(input), "Authorize this MCP client with the specified access?");
mcp.command("disconnect").argument("<id>", "MCP client ID").option("-y, --yes", "Confirm revocation")
  .description("Revoke an MCP client's authorization")
  .action((id: string, opts) => printResult(async () => {
    await confirmOrExit(opts.yes, `Disconnect MCP client ${id}?`);
    return getShipClient().tokens.disconnectMcpClient(id);
  }));
tokenCommand.addCommand(mcp);
