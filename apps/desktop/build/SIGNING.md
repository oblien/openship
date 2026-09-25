Desktop updates require both a SHA-256 sidecar and a publisher signature. The
updater verifies the downloaded bytes, installer name and release version against
the public key embedded from `src/main/update-trust.json`. Missing or invalid
proofs stop installation, including for unsigned legacy release assets.

The GitHub release workflow runs `scripts/sign-updates.mjs` with the encrypted
repository secret `OPENSHIP_DESKTOP_SIGNING_KEY` (an Ed25519 PKCS#8 PEM private
key). It verifies that the secret matches the checked-in public key, then uploads
an additional `<installer>.sig` file for each desktop installer. The private key
is never bundled or committed. OS signing and notarization run separately.

The version-1 signature covers the UTF-8 JSON serialization of these fields in
this order: `format`, `version`, `name`, `sha256`. The `.sig` JSON adds the
base64-encoded detached Ed25519 `signature`. `version` excludes the leading `v`.

Keep the signing key stable across releases. Rotation requires a coordinated
transition release that trusts both publisher keys before replacing the old
signing key. Changing only the repository secret will fail the release check.

Run `bun run test test/update-signature.test.ts test/preload-sandbox.test.ts`
from `apps/desktop` to check the signer/updater contract and bundled preload.
