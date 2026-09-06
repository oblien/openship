import { describe, expect, it } from "vitest";
import { hashPassword } from "better-auth/crypto";
import { base32 } from "@better-auth/utils/base32";
import { db, eq, schema } from "@repo/db";
import { generateId } from "@repo/core";
import { auth } from "../../src/lib/auth";
import { provisionUser } from "../../src/lib/provision-user";

const PASSWORD = "correct-password";
const AUTH_ORIGIN = "http://localhost:4000";

class CookieJar {
  private readonly values = new Map<string, string>();

  clearSession(): void {
    for (const name of this.values.keys()) {
      if (name.includes("session_token") || name.includes("two_factor")) {
        this.values.delete(name);
      }
    }
  }

  has(fragment: string): boolean {
    return [...this.values.keys()].some((name) => name.includes(fragment));
  }

  header(): string | undefined {
    if (this.values.size === 0) return undefined;
    return [...this.values].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  ingest(response: Response): void {
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = setCookie.split(";");
      const separator = pair.indexOf("=");
      if (separator < 1) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute));
      if (expired || !value) this.values.delete(name);
      else this.values.set(name, value);
    }
  }
}

type JsonBody = Record<string, unknown>;

async function post(path: string, body: JsonBody, jar = new CookieJar()) {
  const cookie = jar.header();
  const response = await auth.handler(
    new Request(`${AUTH_ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: AUTH_ORIGIN,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
  jar.ingest(response);
  const json = (await response.json()) as JsonBody;
  return { response, json, jar };
}

let fixtureSequence = 0;

async function createCredentialFixture() {
  fixtureSequence += 1;
  const id = generateId("usr");
  const email = `two-factor-${fixtureSequence}@example.com`;
  await provisionUser({ id, name: "Two Factor Test", email, emailVerified: true });
  await db.insert(schema.account).values({
    id: generateId("acc"),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(PASSWORD),
  });
  return { id, email };
}

async function signIn(email: string, jar = new CookieJar()) {
  return post("/sign-in/email", { email, password: PASSWORD }, jar);
}

async function currentTotp(uriSecret: string): Promise<string> {
  const secret = new TextDecoder().decode(base32.decode(uriSecret));
  const result = await auth.api.generateTOTP({ body: { secret } });
  return result.code;
}

async function enrollFixture() {
  const user = await createCredentialFixture();
  const signedIn = await signIn(user.email);
  expect(signedIn.response.status).toBe(200);
  expect(signedIn.json.token).toEqual(expect.any(String));

  const enabled = await post("/two-factor/enable", { password: PASSWORD }, signedIn.jar);
  expect(enabled.response.status).toBe(200);
  const totpURI = enabled.json.totpURI as string;
  const backupCodes = enabled.json.backupCodes as string[];
  const secret = new URL(totpURI).searchParams.get("secret");
  expect(secret).toEqual(expect.any(String));

  const verified = await post(
    "/two-factor/verify-totp",
    { code: await currentTotp(secret!), trustDevice: false },
    enabled.jar,
  );
  expect(
    verified.response.status,
    JSON.stringify({ json: verified.json, cookie: verified.jar.header() }),
  ).toBe(200);
  expect(verified.json.token).toEqual(expect.any(String));

  return { ...user, jar: verified.jar, secret: secret!, backupCodes };
}

describe("Better Auth two-factor HTTP contract", () => {
  it("keeps non-enrolled credential login as a one-step session", async () => {
    const user = await createCredentialFixture();
    const result = await signIn(user.email);

    expect(result.response.status).toBe(200);
    expect(result.json.token).toEqual(expect.any(String));
    expect(result.json.twoFactorRedirect).toBeUndefined();
    expect(result.jar.has("session_token")).toBe(true);
  });

  it("provisions one authenticator and ten codes before activation", async () => {
    const user = await createCredentialFixture();
    const signedIn = await signIn(user.email);
    const enabled = await post("/two-factor/enable", { password: PASSWORD }, signedIn.jar);

    expect(enabled.response.status).toBe(200);
    expect(enabled.json.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(enabled.json.backupCodes).toHaveLength(10);

    const [before] = await db
      .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, user.id));
    expect(before?.twoFactorEnabled).toBe(false);

    const secret = new URL(enabled.json.totpURI as string).searchParams.get("secret");
    const verified = await post(
      "/two-factor/verify-totp",
      { code: await currentTotp(secret!), trustDevice: false },
      enabled.jar,
    );
    expect(verified.response.status).toBe(200);

    const [after] = await db
      .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, user.id));
    expect(after?.twoFactorEnabled).toBe(true);
  });

  it("returns a pending challenge without a session for enrolled login", async () => {
    const enrolled = await enrollFixture();
    enrolled.jar.clearSession();
    const challenged = await signIn(enrolled.email, enrolled.jar);

    expect(challenged.response.status).toBe(200);
    expect(challenged.json).toEqual({ twoFactorRedirect: true });
    expect(challenged.jar.has("session_token")).toBe(false);
    expect(challenged.jar.has("two_factor")).toBe(true);
  });

  it("turns one valid TOTP challenge into a session", async () => {
    const enrolled = await enrollFixture();
    enrolled.jar.clearSession();
    const challenged = await signIn(enrolled.email, enrolled.jar);
    const verified = await post(
      "/two-factor/verify-totp",
      { code: await currentTotp(enrolled.secret), trustDevice: false },
      challenged.jar,
    );

    expect(verified.response.status).toBe(200);
    expect(verified.json.token).toEqual(expect.any(String));
    expect(verified.jar.has("session_token")).toBe(true);
    expect(verified.jar.has("two_factor")).toBe(false);
  });

  it("rejects an invalid code or missing pending challenge without a session", async () => {
    const enrolled = await enrollFixture();
    enrolled.jar.clearSession();
    const challenged = await signIn(enrolled.email, enrolled.jar);
    const wrong = await post(
      "/two-factor/verify-totp",
      { code: "0000000", trustDevice: false },
      challenged.jar,
    );

    expect(wrong.response.status).toBe(401);
    expect(wrong.json.code).toBe("INVALID_CODE");
    expect(wrong.jar.has("session_token")).toBe(false);

    const missing = await post("/two-factor/verify-totp", {
      code: await currentTotp(enrolled.secret),
      trustDevice: false,
    });
    expect(missing.response.status).toBe(401);
    expect(missing.json.code).toBe("INVALID_TWO_FACTOR_COOKIE");
    expect(missing.jar.has("session_token")).toBe(false);
  });

  it("consumes a backup code exactly once", async () => {
    const enrolled = await enrollFixture();
    const backupCode = enrolled.backupCodes[0]!;
    enrolled.jar.clearSession();
    const challenged = await signIn(enrolled.email, enrolled.jar);
    const recovered = await post(
      "/two-factor/verify-backup-code",
      { code: backupCode, disableSession: false, trustDevice: false },
      challenged.jar,
    );

    expect(recovered.response.status).toBe(200);
    expect(recovered.json.token).toEqual(expect.any(String));

    recovered.jar.clearSession();
    const replayChallenge = await signIn(enrolled.email, recovered.jar);
    const replay = await post(
      "/two-factor/verify-backup-code",
      { code: backupCode, disableSession: false, trustDevice: false },
      replayChallenge.jar,
    );
    expect(replay.response.status).toBe(401);
    expect(replay.json.code).toBe("INVALID_BACKUP_CODE");
    expect(replay.jar.has("session_token")).toBe(false);
  });

  it("trusts an opted-in browser for 30 days", async () => {
    const enrolled = await enrollFixture();
    enrolled.jar.clearSession();
    const challenged = await signIn(enrolled.email, enrolled.jar);
    const verified = await post(
      "/two-factor/verify-totp",
      { code: await currentTotp(enrolled.secret), trustDevice: true },
      challenged.jar,
    );

    expect(verified.response.headers.getSetCookie()).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/trust_device=.*Max-Age=2592000/i),
      ]),
    );
    expect(verified.jar.has("trust_device")).toBe(true);

    verified.jar.clearSession();
    const trustedLogin = await signIn(enrolled.email, verified.jar);
    expect(trustedLogin.response.status).toBe(200);
    expect(trustedLogin.json.token).toEqual(expect.any(String));
    expect(trustedLogin.json.twoFactorRedirect).toBeUndefined();
    expect(trustedLogin.jar.has("session_token")).toBe(true);
  });
});
