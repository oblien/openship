Desktop updates require both a SHA-256 sidecar and a publisher signature. The
updater verifies the downloaded bytes, installer name and release version against
the public key embedded from `packages/core/src/updates/signing-public-key.json`. Missing or invalid
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

macOS release work is checkpointed in three jobs: build and sign the DMGs,
submit each architecture to Apple, then wait for acceptance and staple the
ticket. The signed DMGs and submission receipts are retained as workflow
artifacts for seven days, separate from published release assets. Receipts
identify the installer checksum, source commit and workflow run; a mismatch
stops notarization.

If Apple polling or stapling fails, use **Re-run failed jobs** on the original
Release run. Successful builds and Apple submissions are reused. Temporary
network failures are retried automatically; a processing timeout leaves the
submission at Apple running, so another attempt resumes that submission.
Rejected submissions and invalid tickets block publication. If Apple's report
requires changing application code, release a new version once any artifacts
of the current version have been published; do not move a published tag.

Run `bun test scripts/macos-notarization.test.ts` from the repository root to
verify checkpoint binding, failure recovery and the publication gate. These
tests simulate Apple responses without using signing credentials.
