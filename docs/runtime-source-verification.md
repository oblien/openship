# Source image updates: live verification

The regular source-update tests use a simulated GitHub transport and real Docker builds and containers.
The opt-in live suite also uses GitHub's real API, the existing credential resolver and PR publisher,
and a real local HTTP listener with the remote SDK. It does not load a developer's application database.

Create a private disposable GitHub repository named `openship-runtime-source-verification-*`, with
an initial commit. Sign in with `gh auth login` as an account that can write contents and pull requests
there, and select a dedicated Docker daemon. Then run:

```sh
OPENSHIP_LIVE_SOURCE_REPO=owner/openship-runtime-source-verification-example \
  bun run --cwd apps/api test:live-source
```

Set `DOCKER_HOST` if the test daemon is not the default. The test reads the GitHub credential through
`gh auth token` in memory and saves it encrypted to an isolated test user in the in-memory database.
It does not print the credential or send it to Docker. Production GitHub connections are not modified.
The suite refuses repositories that are public, archived, or do not have the verification name prefix.

It creates an isolated base branch, exercises an expired credential and workspace access denial,
creates real Dockerfile and Compose draft PRs through Openship, records their author and verifies the exact change,
then explicitly marks those PRs ready and merges them as test setup. Product code never performs the merge.
The merged source drives a real Docker build and running HTTP service; a second rebuild must still
report the patched runtime. A Compose service replacement must retain its named-volume contents and
environment. No container publishes a host port.

Teardown closes outstanding test PRs, removes only the run's branches, containers, output images,
networks, volumes and checkout, and asserts that the repository's default branch did not change.
The closed/merged PRs remain as review evidence. The suite is excluded from ordinary CI because it
requires a write-enabled GitHub account and creates external resources.

GitHub App scope rejection, provider outages/rate limits, permissions revoked after review, file
and tenant boundaries, and UI recovery are covered by the automated tests. GitHub does not provide
universal write-permission introspection for every user-token kind: preflight checks known blockers;
actual writes still enforce provider permissions. An App probe requests exactly the required scope
for the selected repository through the existing installation-token service.

Live verification on November 11, 2026 used the connected **Hydralerne** account and a dedicated Colima
Docker daemon. [Dockerfile PR #3](https://github.com/Hydralerne/openship-runtime-source-verification-20261111/pull/3)
and [Compose PR #4](https://github.com/Hydralerne/openship-runtime-source-verification-20261111/pull/4)
were created as drafts through Openship and merged only into the isolated verification branch.
The Dockerfile build and subsequent rebuild both served `v22.23.4:unchanged`; the Compose replacement
reported `v22.23.4` and retained `retained-data` and `KEEP=unchanged`. A first run exposed an error in
the test fixture's deployment status bookkeeping; that fixture was corrected before the successful
rerun. App-bot attribution was not exercised against a live installation.
