import { describe, expect, it } from "vitest";

// A plain static import: schemas.ts pulls in only zod, with no transitive
// reach into src/env, so there is nothing to sequence behind an await.
import { defaultUserSettings, signInSchema, userSettingsSchema } from "../src/lib/schemas";

describe("signInSchema", () => {
  it("accepts normal and plus-addressed email credentials", () => {
    for (const credentials of [
      { email: "user@example.com", password: "correct horse" },
      { email: "a+tag@mail.example.co.uk", password: "not-empty" },
    ]) {
      expect(signInSchema.safeParse(credentials)).toEqual({
        success: true,
        data: credentials,
      });
    }
  });

  it("rejects malformed email addresses", () => {
    for (const email of ["", "not-an-email", "@example.com", "user@example"]) {
      expect(signInSchema.safeParse({ email, password: "secret" }).success).toBe(false);
    }
  });

  it("rejects an empty password", () => {
    expect(signInSchema.safeParse({ email: "user@example.com", password: "" }).success).toBe(false);
  });

  it("rejects client-selected mail hosts and arbitrary fields to prevent credential exfiltration", () => {
    // A phishing page must not redirect a victim's password to an attacker-controlled mail host.
    for (const field of [
      "imapHost",
      "imapPort",
      "smtpHost",
      "smtpPort",
      // Unknown fields must not become a future bypass for the same trust boundary.
      "attackerControlledEndpoint",
      "isAdmin",
    ]) {
      const payload = {
        email: "user@example.com",
        password: "secret",
        [field]: field === "imapPort" || field === "smtpPort" ? 993 : "evil.example",
      };

      expect(signInSchema.safeParse(payload).success).toBe(false);
    }
  });
});

describe("userSettingsSchema", () => {
  it("exports the complete default settings object", () => {
    expect(defaultUserSettings).toEqual({
      language: "en",
      timezone: "UTC",
      dynamicContent: false,
      externalImages: true,
      trustedSenders: [],
      isOnboarded: false,
      colorTheme: "system",
      inboxType: "default",
      signature: "",
      zeroSignature: true,
      undoSendTime: 5,
      customPrompt: "",
      autoRead: false,
      noteFolderId: null,
      defaultEmailAlias: "",
      undoSendEnabled: true,
      animations: true,
      imageCompression: true,
    });
  });

  it("applies every field default when parsing an empty object", () => {
    expect(userSettingsSchema.parse({})).toEqual(defaultUserSettings);
  });

  it("rejects values outside the declared settings enums", () => {
    expect(userSettingsSchema.safeParse({ colorTheme: "sepia" }).success).toBe(false);
    expect(userSettingsSchema.safeParse({ inboxType: "all-mail" }).success).toBe(false);
  });

  it("accepts the exact undo-send time boundaries", () => {
    expect(userSettingsSchema.parse({ undoSendTime: 0 }).undoSendTime).toBe(0);
    expect(userSettingsSchema.parse({ undoSendTime: 30 }).undoSendTime).toBe(30);
  });

  it("rejects undo-send times outside the range or integer contract", () => {
    for (const undoSendTime of [-1, 31, 1.5, "5", Number.NaN]) {
      expect(userSettingsSchema.safeParse({ undoSendTime }).success).toBe(false);
    }
  });
});
