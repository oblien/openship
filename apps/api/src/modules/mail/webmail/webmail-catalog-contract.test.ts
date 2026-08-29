/**
 * The contract between this module and `catalog/webmail.json`.
 *
 * Webmail deploys through the GENERIC installer, which means the mail wizard's
 * knowledge of the app is reduced to a handful of strings: setting keys it writes,
 * an endpoint it routes, an image it expects to exist. None of that is type-checked
 * — the catalog is JSON — so a rename on either side surfaces at install time as a
 * 400 `Unknown setting: webmail.X`, or worse as a webmail deployed with no backend
 * pointing at nothing.
 *
 * These assertions are cheap and they fail on the side of the boundary that broke.
 */
import { describe, it, expect } from "vitest";
import { flattenSettingFields, getAppEndpoints, getAppSettings, getAppTemplate } from "@repo/core";
import { WEBMAIL_SETTING_KEYS, WEBMAIL_TEMPLATE_ID } from "./webmail-install.service";

const template = getAppTemplate(WEBMAIL_TEMPLATE_ID);

describe("webmail catalog contract", () => {
  it("ships the app the install service asks for", () => {
    expect(template, `catalog has no "${WEBMAIL_TEMPLATE_ID}" app`).toBeDefined();
    // `installApp` returns a non-template result for anything else, and the
    // install service turns that into a 409 rather than a half-made project.
    expect(template?.kind).toBe("template");
  });

  it("declares every setting key the install service writes", () => {
    // Exactly the lookup `updateAppProjectSettings` does before it accepts a write.
    const fields = flattenSettingFields(getAppSettings(template!));
    for (const key of Object.values(WEBMAIL_SETTING_KEYS)) {
      const field = fields.find((f) => f.service === "webmail" && f.key === key);
      expect(field, `webmail.${key} is not a declared setting`).toBeDefined();
    }
  });

  it("keeps the backend fields on the install step, and redeployable", () => {
    // The wizard renders `installStep` fields; a backend the operator can't set at
    // install time would deploy a webmail pointed at the catalog placeholder. And a
    // backend edited later only reaches the container through a redeploy.
    const fields = flattenSettingFields(getAppSettings(template!));
    const backend = [
      WEBMAIL_SETTING_KEYS.imapHost,
      WEBMAIL_SETTING_KEYS.imapPort,
      WEBMAIL_SETTING_KEYS.smtpHost,
      WEBMAIL_SETTING_KEYS.smtpPort,
    ];
    for (const key of backend) {
      const field = fields.find((f) => f.key === key)!;
      expect(field.installStep, `webmail.${key} must be an install-step field`).toBe(true);
      expect(field.requiresRedeploy, `webmail.${key} must require a redeploy`).toBe(true);
    }
  });

  it("generates the two secrets nobody may be asked for", () => {
    // SESSION_ENCRYPTION_KEY is generated ONCE at install and reused from the
    // project's env on every redeploy — a fresh key signs every operator out.
    // BRANDING_ADMIN_TOKEN is openship→Zero only and must never reach a form.
    const configKeys = new Map((template?.configFields ?? []).map((f) => [f.key, f]));
    for (const key of ["SESSION_ENCRYPTION_KEY", "BRANDING_ADMIN_TOKEN"]) {
      const field = configKeys.get(key);
      expect(field, `${key} is not a generated config field`).toBeDefined();
      expect(field?.generate).toBe("secret");
      expect(field?.secret).toBe(true);
    }
  });

  it("keeps both secrets un-inlined, so a missing one can be minted later", () => {
    // `ensureGeneratedAppSecrets` refuses to mint a key the template substitutes into
    // some other string, because those copies were written once and would contradict a
    // new value. Inlining either of these would silently disable the backfill that
    // stops webmail deploying without a SESSION_ENCRYPTION_KEY (#566) — and the image
    // treats that as fatal.
    const inlined = [
      ...(template?.services ?? []).flatMap((s) => Object.values(s.environment ?? {})),
      ...(template?.files ?? []).map((f) => f.content),
      ...(template?.services ?? []).map((s) => s.build?.dockerfile ?? ""),
    ].join("\n");
    for (const key of ["SESSION_ENCRYPTION_KEY", "BRANDING_ADMIN_TOKEN"]) {
      // Tolerant of inner whitespace, exactly like the substitution itself.
      expect(inlined, `${key} must not be inlined`).not.toMatch(
        new RegExp(`\\{\\{\\s*config:${key}\\s*\\}\\}`),
      );
    }
  });

  it("exposes one routable HTTP endpoint", () => {
    // `startWebmailDeploy` reads endpoint[0] to size its route instead of pinning a
    // port number — an app with no endpoint would deploy unreachable.
    const endpoints = getAppEndpoints(template!);
    expect(endpoints.length).toBeGreaterThan(0);
    expect(endpoints[0].service).toBe("webmail");
    expect(endpoints[0].kind).toBe("http");
    expect(endpoints[0].port).toBeGreaterThan(0);
  });

  it("runs a published image, not a build", () => {
    // The dist shipper this replaced is gone. A `build` here would mean the mail
    // wizard needs a source checkout on the target server, which it never has.
    const service = template?.services?.find((s) => s.name === "webmail");
    expect(service?.image, "webmail service must run a published image").toBeTruthy();
    expect(service?.build).toBeUndefined();
  });
});
