import { afterAll, describe, expect, it, vi } from "vitest";

const previous = vi.hoisted(() => {
  const values = {
    CLOUD_MODE: "true",
    OPENSHIP_TARGET: "local-saas",
    BETTER_AUTH_SECRET: "oidc-cloud-test-secret-00000000000000000000000000000000",
    OIDC_ISSUER: "https://idp.example.test",
    OIDC_CLIENT_ID: "cloud-ignored-client",
    OIDC_CLIENT_SECRET: "cloud-ignored-secret",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return previous;
});

import { closeDb, db, schema } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import {
  configuredAuthProviders,
  oidcProviderConfig,
} from "@repo/platform/engine/lib/auth-providers";

afterAll(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await closeDb();
});

describe("Self-hosted OIDC stays disabled on Openship Cloud", () => {
  it("does not register or advertise an instance-wide identity provider", () => {
    expect(oidcProviderConfig()).toBeUndefined();
    expect(configuredAuthProviders().some((provider) => provider.id === "oidc")).toBe(false);
  });

  it.each([
    "/sign-in/oauth2",
    "/sign-in/social",
    "/oauth2/link",
    "/link-social",
    "/oauth2/callback/oidc",
    "/callback/oidc",
  ])(
    "rejects direct %s requests without contacting an IdP or creating local credentials",
    async (path) => {
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("No IdP request is allowed"));
      try {
        const callback = path.includes("/callback/");
        const response = await auth.handler(
          new Request(
            `http://localhost:4100/api/auth${path}${callback ? "?code=test&state=test" : ""}`,
            {
              method: callback ? "GET" : "POST",
              headers: { "Content-Type": "application/json" },
              ...(!callback && {
                body: JSON.stringify({
                  providerId: "oidc",
                  provider: "oidc",
                  callbackURL: "http://localhost:3002/projects",
                }),
              }),
            },
          ),
        );
        if (response.status === 302) {
          expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBeTruthy();
        } else expect(response.status).toBeGreaterThanOrEqual(400);
        expect(fetch).not.toHaveBeenCalled();
        expect(await db.select().from(schema.account)).toHaveLength(0);
        expect(await db.select().from(schema.user)).toHaveLength(0);
        expect(await db.select().from(schema.session)).toHaveLength(0);
      } finally {
        fetch.mockRestore();
      }
    },
  );
});
