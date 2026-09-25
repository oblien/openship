import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signDesktopUpdates } from "../scripts/sign-updates.mjs";

const h = vi.hoisted(() => ({ publicKey: "", directory: "", fetch: vi.fn() }));
vi.mock("../src/main/update-trust.json", () => ({ default: { get publicKey() { return h.publicKey; } } }));
vi.mock("electron", () => ({ app: { getPath: () => h.directory }, net: { fetch: h.fetch }, shell: {} }));
import { downloadUpdate } from "../src/main/updater";
import { verifyUpdateSignature } from "../src/main/update-signature";

const name = "Openship.AppImage";
const version = "9.8.7";
const url = `https://github.com/oblien/openship/releases/download/v${version}/${name}`;
const asset = { name, url, size: 10 };
const bytes = Buffer.from("signed-installer-fixture");
const sha256 = createHash("sha256").update(bytes).digest("hex");
let proof: Record<string, unknown>;

beforeEach(async () => {
  h.directory = await mkdtemp(join(tmpdir(), "openship-update-test-"));
  const keys = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  h.publicKey = keys.publicKey;
  await writeFile(join(h.directory, name), bytes);
  await signDesktopUpdates({ directory: h.directory, version, privateKey: keys.privateKey, publicKey: keys.publicKey });
  proof = JSON.parse(await readFile(join(h.directory, `${name}.sig`), "utf8"));
  h.fetch.mockReset().mockImplementation(async (target: string) => {
    if (target.endsWith(".sha256")) return new Response(sha256);
    if (target.endsWith(".sig")) return Response.json(proof);
    return new Response(bytes);
  });
});
afterEach(() => rm(h.directory, { recursive: true, force: true }));

describe("publisher-authenticated desktop updates", () => {
  it("installs only bytes verified against the real release signer's proof", async () => {
    const downloaded = await downloadUpdate(asset, version, () => {});
    expect(await readFile(downloaded)).toEqual(bytes);
    expect(h.fetch).toHaveBeenCalledTimes(3);
  });
  it.each(["missing", "malformed", "oversize"])("refuses a %s signature and removes the downloaded installer", async mode => {
    h.fetch.mockImplementation(async (target: string) => target.endsWith(".sig")
      ? new Response(mode === "oversize" ? "x".repeat(4097) : "invalid", { status: mode === "missing" ? 404 : 200 })
      : new Response(target.endsWith(".sha256") ? sha256 : bytes));
    await expect(downloadUpdate(asset, version, () => {})).rejects.toThrow("signature");
    expect((await readdir(h.directory)).filter(entry => entry.startsWith("openship-update-"))).toEqual([]);
  });
  it("does not accept replacing both the installer and checksum", async () => {
    const replacement = Buffer.from("attacker-replacement");
    h.fetch.mockImplementation(async (target: string) => target.endsWith(".sig") ? Response.json(proof)
      : new Response(target.endsWith(".sha256") ? createHash("sha256").update(replacement).digest("hex") : replacement));
    await expect(downloadUpdate(asset, version, () => {})).rejects.toThrow("signature");
  });
  it.each(["version", "name", "sha256"])("binds the signed %s to the selected release", field => {
    expect(() => verifyUpdateSignature({ ...proof, [field]: "different" }, { version, name, sha256 })).toThrow("signature");
  });
  it("refuses a signature from a different publisher", () => {
    const { publicKey } = generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" } });
    expect(() => verifyUpdateSignature(proof, { version, name, sha256 }, publicKey)).toThrow("signature");
  });
  it("rejects a cross-origin redirect before connecting to its destination", async () => {
    h.fetch.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://attacker.test/installer" } }));
    await expect(downloadUpdate(asset, version, () => {})).rejects.toThrow("Untrusted");
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
  it("still requires the checksum and refuses release URL/name mismatches", async () => {
    h.fetch.mockImplementation(async (target: string) => target.endsWith(".sha256") ? new Response("missing", { status: 404 }) : new Response(bytes));
    await expect(downloadUpdate(asset, version, () => {})).rejects.toThrow("integrity");
    h.fetch.mockClear();
    await expect(downloadUpdate({ ...asset, name: "../escape" }, version, () => {})).rejects.toThrow("untrusted");
    await expect(downloadUpdate(asset, "1.0.0", () => {})).rejects.toThrow("untrusted");
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("refuses to publish with an absent or mismatched signing key", async () => {
    await expect(signDesktopUpdates({ directory: h.directory, version, privateKey: "", publicKey: h.publicKey })).rejects.toThrow("required");
    const { privateKey } = generateKeyPairSync("ed25519", { privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    await expect(signDesktopUpdates({ directory: h.directory, version, privateKey, publicKey: h.publicKey })).rejects.toThrow("does not match");
  });
});
