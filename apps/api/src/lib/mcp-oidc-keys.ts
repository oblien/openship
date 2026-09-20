/**
 * The instance's OIDC signing key for MCP OAuth.
 *
 * better-auth's mcp() plugin advertises `jwks_uri` and RS256 id_tokens in its
 * discovery metadata, but implements neither: the jwks endpoint doesn't exist,
 * and the id_token it mints is HS256 over a RANDOM throwaway key with no `iss`
 * claim and a millisecond `iat`. No verifying client can accept it — Claude.ai
 * fetches the jwks, finds nothing to validate the id_token with, and aborts the
 * connection right after the token exchange ("the integration rejected the
 * credentials it just issued").
 *
 * This module owns a real RSA-2048 keypair for the instance: generated once,
 * persisted in the Better Auth `verification` table (a generic identifier →
 * value store; no schema migration needed), served at the advertised jwks_uri,
 * and used to re-sign the id_token with correct OIDC claims (see
 * modules/auth/mcp-token.handler.ts).
 */

import {
  createPrivateKey,
  createPublicKey,
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
import { db, schema, eq } from "@repo/db";

/** Row identifier in the `verification` table. */
const STORE_IDENTIFIER = "mcp:oidc-signing-key";

/** Effectively "never" — the key must outlive better-auth's expiry sweeps. */
const STORE_EXPIRES_AT = new Date("2200-01-01T00:00:00Z");

export interface McpSigningKey {
  privateKey: KeyObject;
  /** Public half as a JWK, ready to serve from the jwks endpoint. */
  publicJwk: Record<string, unknown>;
  kid: string;
}

let cached: McpSigningKey | null = null;
let inflight: Promise<McpSigningKey> | null = null;
let cacheGeneration = 0;

/** Drop key material derived from the verification table after a DB restore. */
export function invalidateMcpSigningKeyCache(): void {
  cacheGeneration += 1;
  cached = null;
  inflight = null;
}

/** RFC 7638 JWK thumbprint of an RSA public JWK — the standard, stable kid. */
function thumbprint(jwk: { e: string; kty: string; n: string }): string {
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return createHash("sha256").update(canonical).digest("base64url");
}

function materialize(privateJwk: Record<string, unknown>): McpSigningKey {
  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  const publicKey = createPublicKey(privateKey);
  const exported = publicKey.export({ format: "jwk" }) as { e: string; kty: string; n: string };
  const kid = thumbprint(exported);
  return {
    privateKey,
    publicJwk: { ...exported, kid, alg: "RS256", use: "sig" },
    kid,
  };
}

async function loadOrCreate(): Promise<McpSigningKey> {
  const [row] = await db
    .select({ id: schema.verification.id, value: schema.verification.value })
    .from(schema.verification)
    .where(eq(schema.verification.identifier, STORE_IDENTIFIER))
    .limit(1);

  if (row) {
    try {
      return materialize(JSON.parse(row.value) as Record<string, unknown>);
    } catch {
      // Corrupt row (manual edit, partial write): fall through and replace it.
      await db.delete(schema.verification).where(eq(schema.verification.id, row.id));
    }
  }

  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateJwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  await db.insert(schema.verification).values({
    id: `mcp-oidc-${createHash("sha256").update(JSON.stringify(privateJwk)).digest("hex").slice(0, 16)}`,
    identifier: STORE_IDENTIFIER,
    value: JSON.stringify(privateJwk),
    expiresAt: STORE_EXPIRES_AT,
  });
  return materialize(privateJwk);
}

/** The instance signing key — generated on first use, cached for the process. */
export async function getMcpSigningKey(): Promise<McpSigningKey> {
  if (cached) return cached;
  if (inflight) return inflight;
  const generation = cacheGeneration;
  let pending: Promise<McpSigningKey>;
  pending = loadOrCreate().then(
    (key) => {
      // An import may commit while loadOrCreate is awaiting the DB. Return the
      // value to that request, but do not poison the post-import cache with it.
      if (generation === cacheGeneration) cached = key;
      if (inflight === pending) inflight = null;
      return key;
    },
    (error) => {
      if (inflight === pending) inflight = null;
      throw error;
    },
  );
  inflight = pending;
  return inflight;
}

/** Sign an RS256 JWT with the instance key. */
export async function signRs256Jwt(claims: Record<string, unknown>): Promise<string> {
  const key = await getMcpSigningKey();
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = cryptoSign("sha256", Buffer.from(`${header}.${payload}`), key.privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}
