# Operator move runbook

Human-operated rehearsal order for moving our apps onto Operator releases.
**Do not execute this document as a live cutover.** No SSH to production. No
pointer flips from this PR. Recipes live in `fixtures/operator-recipes/` and
carry no secrets and no host paths.

## Runtime vs code vs persistent state

Keep these three lanes separate on every move:

| Lane | What it is | When it changes |
|---|---|---|
| **Runtime** | OS, PHP/Node, extensions, process manager, mounts | Rarely. Rebuild only when Dockerfile, Compose, or PHP extensions change. |
| **Application release** | Exact Git SHA or uploaded artifact under `current` | Constantly. Deploy code (or upload an artifact). |
| **Persistent state** | SQLite, uploads, `storage` | Never replaced or pruned with a release. Back it up; do not ship it in the tree. |

Mail is the exception: its **normal** deployment is an **immutable image
release**. Leave `mountedRelease.enabled` false. Do not invent a mounted tree
for Mail just to match the other apps.

A Public change must never rebuild Staff or Mail. Rehearse and move Staff as
its own service.

## Validation policy

Every staged release, including the first production attempt:

1. **Kill during staging and activation.** Failed incoming trees, leftover
   `openship-release-*` builders, and temp creds are removed. Do not leave a
   half-extracted tree as `current`.
2. **Unhealthy release rolls back.** Remember the previous `current` target
   before the flip. If reload, container health, or public HTTPS fails,
   restore the previous pointer, reload again, and record the rollback
   reason. A first failure with no previous pointer must keep serving the
   existing runtime — never delete `current` on the first miss.
3. **Migrate on a disposable stack.** `artisan migrate` (and Composer when
   `composer.lock` changed) runs in a disposable builder with persistent
   caches. The live app container does not grow compilers or run migrations
   in place.

## Export / import

Back up non-secret project, server, route, and release-recipe config with the
existing CLI:

```text
openship project export-config
```

That is `GET /api/projects/config-export`. It allowlists
`project.mountedRelease` and strips SSH keys, clone tokens, webhook secrets,
and env values. Re-import by applying the exported JSON (and the matching
recipe under `fixtures/operator-recipes/`) onto the target project in the
control plane — do not paste secrets back into the snapshot.

## Move order

Do these steps in order. Finish one before starting the next.

### 1. Keep Dashwood as the fast-release pilot

Recipe: `fixtures/operator-recipes/dashwood.json`

- Git-prebuilt static release. `sourcePath` is the committed static output
  (`out`) when the repo root is not already the served tree.
- No persist paths. No Composer. No migrations.
- Confirm **Deploy code** flips `current` without a runtime rebuild.
- Confirm an unhealthy activate restores the previous pointer.
- Leave Dashwood on this path; do not wait for Lake Forest or AE.

### 2. Finish Lake Forest artifact + SQLite backup preset

Recipe: `fixtures/operator-recipes/lake-forest.json`

- Normal deployment is a **local artifact** (`buildMode: upload`). The
  mounted tree is still a prebuilt extract — the planner hint is upload, not
  a server prepare.
- Persist `storage` and `database/database.sqlite`. Do not persist the whole
  `database/` directory (migrations live there).
- Enable the **sqlite** backup preset and take a backup before the first
  production artifact.
- Rehearse upload → verify checksum → activate → health. Confirm a failed
  health check rolls back without touching SQLite.

### 3. Rehearse AE Public on staging

Recipe: `fixtures/operator-recipes/ae-public.json` applied to the **staging**
environment.

- PHP/Blade code release. Compiled assets come from Git (`buildMode:
  prebuilt`). Composer vendor is prepared **only** when
  `apps/public/composer.lock` changes.
- Planner prefix `apps/public`. Push a Staff-only or Mail-only commit and
  confirm Public is skipped.
- Rebuild runtime once so the stable release mount is attached, then use
  **Deploy code** for application changes.
- Exercise migrate-on-disposable-stack and the unhealthy-rollback path on
  staging before any production pointer moves.

### 4. Move AE Public production

Same recipe, production environment.

- Export config first (`openship project export-config`).
- Runtime rebuild only if the staging rehearsal proved the mount, image, and
  extensions.
- Deploy the rehearsed SHA as a code release.
- Watch container health **and** public HTTPS. Roll back on either failure.
- Do not start Staff until Public has been stable on the new path.

### 5. Rehearse and move AE Staff separately

Recipe: `fixtures/operator-recipes/ae-staff.json`

- Same shape as Public (`apps/staff` prefix, Git-tracked assets, Composer
  only on lock change) but a **different service**. Do not share Public's
  release tree, persist volume, or deploy lease.
- Staging rehearsal first, then production, same validation policy.
- A Staff move must not rebuild Public or Mail.

### 6. Keep Mail on immutable images

Recipe: `fixtures/operator-recipes/ae-mail.json`

- `mountedRelease.enabled` is **false**. Workload is an image.
- Image or Compose changes go through the runtime pipeline.
- Roll back by restoring the previous image pointer, not a `current`
  symlink.
- Leave Mail here unless a later wave deliberately changes the workload.

## After each move

- Combined live state should show a code SHA (or “image” for Mail), a
  runtime digest, the server name, and public HTTPS when the app is public.
- Confirm persist paths still hold yesterday's data.
- Keep the export snapshot with the release notes for that move.
