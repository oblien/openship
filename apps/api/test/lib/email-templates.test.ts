/**
 * Escaping contract for transactional email templates: user-controlled fields
 * (display names, organization names, invitee address) are escaped in the
 * `html` output, while the plaintext `subject`/`text` parts keep the raw value.
 */

import { describe, expect, it } from "vitest";
import { organizationInviteEmail, resetPasswordEmail } from "../../src/lib/email-templates";

describe("email-templates — HTML injection is neutralized", () => {
  it("escapes attacker-controlled org name and inviter name in the invite HTML", () => {
    const email = organizationInviteEmail({
      invitee: { email: "victim@example.com" },
      inviter: { name: "<b>Mallory</b>", email: "mallory@evil.example" },
      organizationName: '<img src=x onerror="alert(1)">',
      url: "https://openship.example/accept-invite/abc",
    });

    // The raw markup must NOT appear as live HTML.
    expect(email.html).not.toContain("<img src=x onerror=");
    expect(email.html).not.toContain("<b>Mallory</b>");

    // It must appear escaped instead.
    expect(email.html).toContain("&lt;img src=x onerror=");
    expect(email.html).toContain("&lt;b&gt;Mallory&lt;/b&gt;");

    // Plaintext parts are not HTML — they keep the raw value.
    expect(email.text).toContain("<img src=x onerror=");
    expect(email.subject).toContain("<img src=x onerror=");
  });

  it("escapes the invitee email in the invite HTML", () => {
    const email = organizationInviteEmail({
      invitee: { email: '"><script>@example.com' },
      inviter: { name: "Alice", email: "alice@example.com" },
      organizationName: "Acme",
      url: "https://openship.example/accept-invite/abc",
    });

    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("escapes a user's display name in the greeting (reset password HTML)", () => {
    const email = resetPasswordEmail(
      { name: "<script>alert(1)</script>", email: "user@example.com" },
      "https://openship.example/reset/xyz",
    );

    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");

    // Plaintext greeting keeps the raw value.
    expect(email.text).toContain("<script>alert(1)</script>");
  });
});
