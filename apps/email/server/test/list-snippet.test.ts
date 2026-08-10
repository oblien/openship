import { describe, it, expect } from "bun:test";
import { extractListSnippet } from "../src/lib/imap-driver";

const CRLF = "\r\n";

function bodyParts(raw: string | Buffer): Map<string, Buffer> {
  return new Map([["text", typeof raw === "string" ? Buffer.from(raw, "latin1") : raw]]);
}

function base64Lines(bytes: Buffer): string {
  return bytes.toString("base64").replace(/(.{76})/g, `$1${CRLF}`);
}

describe("extractListSnippet", () => {
  describe("charset", () => {
    it("decodes an ISO-8859-1 quoted-printable text/plain part", () => {
      const body =
        `--B1${CRLF}` +
        `Content-Type: text/plain; charset=ISO-8859-1${CRLF}` +
        `Content-Transfer-Encoding: quoted-printable${CRLF}${CRLF}` +
        `Hola Bob, la reuni=F3n de ma=F1ana se traslada a las diez. Un saludo.${CRLF}` +
        `--B1--${CRLF}`;
      const struct = {
        type: "multipart/alternative",
        childNodes: [
          {
            part: "1",
            type: "text/plain",
            parameters: { charset: "ISO-8859-1" },
            encoding: "quoted-printable",
          },
        ],
      };

      expect(extractListSnippet(bodyParts(body), struct)).toBe(
        "Hola Bob, la reunión de mañana se traslada a las diez. Un saludo.",
      );
    });

    it("decodes a windows-1252 base64 text/plain part", () => {
      const raw = Buffer.from("Your order shipped \x97 \x93track it\x94 for updates.", "latin1");
      const struct = {
        type: "text/plain",
        parameters: { charset: "Windows-1252" },
        encoding: "base64",
      };

      expect(extractListSnippet(bodyParts(base64Lines(raw)), struct)).toBe(
        "Your order shipped — “track it” for updates.",
      );
    });

    it("decodes UTF-8 bytes in a part mislabelled as us-ascii", () => {
      const struct = {
        type: "text/plain",
        parameters: { charset: "us-ascii" },
        encoding: "7bit",
      };

      expect(
        extractListSnippet(bodyParts(Buffer.from("Cafés — closing at 5.", "utf8")), struct),
      ).toBe("Cafés — closing at 5.");
    });

    it("falls back to utf8 for a charset label TextDecoder does not know", () => {
      const struct = {
        type: "text/plain",
        parameters: { charset: "x-mystery-charset" },
        encoding: "7bit",
      };

      expect(
        extractListSnippet(bodyParts(Buffer.from("Réunion demain à dix heures.", "utf8")), struct),
      ).toBe("Réunion demain à dix heures.");
    });
  });

  describe("non-text leaf parts", () => {
    it("returns empty for an S/MIME application/pkcs7-mime message", () => {
      const der = Buffer.from([
        0x30, 0x82, 0x03, 0x0c, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02,
        0xa0, 0x82, 0x02, 0xfd, 0x30, 0x82, 0x02, 0xf9, 0x02, 0x01, 0x01, 0x31, 0x0f, 0x30, 0x0d,
      ]);
      const struct = {
        type: "application/pkcs7-mime",
        parameters: { smimetype: "signed-data", name: "smime.p7m" },
        encoding: "base64",
      };

      expect(extractListSnippet(bodyParts(base64Lines(der) + CRLF), struct)).toBe("");
    });

    it("returns empty when a multipart/mixed leads with a PDF attachment", () => {
      const pdf = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\nendobj\n", "latin1");
      const body =
        `--B2${CRLF}` +
        `Content-Type: application/pdf; name="scan_0001.pdf"${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
        base64Lines(pdf) +
        `${CRLF}--B2${CRLF}`;
      const struct = {
        type: "multipart/mixed",
        childNodes: [
          {
            part: "1",
            type: "application/pdf",
            parameters: { name: "scan_0001.pdf" },
            encoding: "base64",
          },
          { part: "2", type: "text/plain", parameters: { charset: "us-ascii" }, encoding: "7bit" },
        ],
      };

      expect(extractListSnippet(bodyParts(body), struct)).toBe("");
    });

    it("returns empty for the PGP/MIME version identification part", () => {
      const body =
        `--B3${CRLF}` +
        `Content-Type: application/pgp-encrypted${CRLF}` +
        `Content-Description: PGP/MIME version identification${CRLF}${CRLF}` +
        `Version: 1${CRLF}` +
        `${CRLF}--B3${CRLF}`;
      const struct = {
        type: "multipart/encrypted",
        parameters: { protocol: "application/pgp-encrypted" },
        childNodes: [
          { part: "1", type: "application/pgp-encrypted", encoding: "7bit" },
          { part: "2", type: "application/octet-stream", encoding: "7bit" },
        ],
      };

      expect(extractListSnippet(bodyParts(body), struct)).toBe("");
    });

    it("returns empty when a multipart/related leads with an inline image", () => {
      const jpeg = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00,
        0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06,
      ]);
      const body =
        `--B4${CRLF}` +
        `Content-Type: image/jpeg; name="logo.jpg"${CRLF}` +
        `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
        base64Lines(jpeg) +
        `${CRLF}--B4${CRLF}`;
      const struct = {
        type: "multipart/related",
        childNodes: [
          { part: "1", type: "image/jpeg", parameters: { name: "logo.jpg" }, encoding: "base64" },
          {
            part: "2",
            type: "text/html",
            parameters: { charset: "utf-8" },
            encoding: "quoted-printable",
          },
        ],
      };

      expect(extractListSnippet(bodyParts(body), struct)).toBe("");
    });

    it("still extracts a snippet when the body structure is unusable", () => {
      const text = "Standing meeting moved to Thursday.";

      expect(extractListSnippet(bodyParts(text), undefined)).toBe(text);
      expect(extractListSnippet(bodyParts(text), { type: "multipart/mixed", childNodes: [] })).toBe(
        text,
      );
    });
  });

  describe("HTML character references", () => {
    it("decodes numeric and named references", () => {
      const html =
        "<p>We&#8217;re excited &mdash; your order&rsquo;s on its way." +
        " Save 20&#37; today &amp; tomorrow. &copy;&nbsp;2026 Acme</p>";
      const struct = { type: "text/html", parameters: { charset: "utf-8" }, encoding: "7bit" };

      expect(extractListSnippet(bodyParts(Buffer.from(html, "utf8")), struct)).toBe(
        "We’re excited — your order’s on its way. Save 20% today & tomorrow. © 2026 Acme",
      );
    });

    it("decodes hexadecimal references", () => {
      const html = "<p>Caf&#xE9; Roma &#x2014; open late</p>";
      const struct = { type: "text/html", parameters: { charset: "utf-8" }, encoding: "7bit" };

      expect(extractListSnippet(bodyParts(Buffer.from(html, "utf8")), struct)).toBe(
        "Café Roma — open late",
      );
    });

    it("does not double-unescape an already-escaped reference", () => {
      const html = "<p>Escaped tag: &amp;lt;script&amp;gt; stays escaped.</p>";
      const struct = { type: "text/html", parameters: { charset: "utf-8" }, encoding: "7bit" };

      expect(extractListSnippet(bodyParts(Buffer.from(html, "utf8")), struct)).toBe(
        "Escaped tag: &lt;script&gt; stays escaped.",
      );
    });

    it("leaves an unrecognised reference verbatim", () => {
      const html = "<p>Ticket &notarealentity; raised for review</p>";
      const struct = { type: "text/html", parameters: { charset: "utf-8" }, encoding: "7bit" };

      expect(extractListSnippet(bodyParts(Buffer.from(html, "utf8")), struct)).toBe(
        "Ticket &notarealentity; raised for review",
      );
    });
  });
});
