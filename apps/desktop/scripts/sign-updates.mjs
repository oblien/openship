/** Release-only signing. Private key comes from the encrypted repository secret. */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function signDesktopUpdates({ directory, version, privateKey, publicKey }) {
  if (!privateKey) throw new Error("OPENSHIP_DESKTOP_SIGNING_KEY is required to publish desktop updates.");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid release version.");
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519" ||
      createPublicKey(key).export({ type: "spki", format: "pem" }) !== publicKey) {
    throw new Error("Release signing key does not match the desktop's pinned public key.");
  }
  const assets = (await readdir(directory)).filter(name => /^Openship(?:-[a-z0-9-]+)?\.(?:dmg|zip|AppImage|deb|rpm)$/.test(name));
  for (const name of assets) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(directory, name))) hash.update(chunk);
    const payload = { format: 1, version, name, sha256: hash.digest("hex") };
    const signature = sign(null, Buffer.from(JSON.stringify(payload)), key).toString("base64");
    await writeFile(join(directory, `${name}.sig`), JSON.stringify({ ...payload, signature }) + "\n");
  }
  return assets;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const trust = JSON.parse(await readFile(new URL("../src/main/update-trust.json", import.meta.url), "utf8"));
  const assets = await signDesktopUpdates({ directory: process.argv[2] ?? "dist",
    version: (process.env.GITHUB_REF_NAME ?? "").replace(/^v/, ""),
    privateKey: process.env.OPENSHIP_DESKTOP_SIGNING_KEY, publicKey: trust.publicKey });
  console.log(`Signed ${assets.length} desktop installers.`);
}
