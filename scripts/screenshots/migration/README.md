# Migration guide screenshots

The Railway and Vercel guide images in `apps/web/public/migrations` render the actual
`PlatformImportReview` component with sample project names and no customer data.
They illustrate the review before import; they do not represent a completed migration.

Start the local dashboard, then run from the repository root:

```sh
SCREENSHOT_ORIGIN=http://localhost:3001 \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
node scripts/screenshots/migration/capture.mjs
```

The script uses a temporary development-only route, blocks browser API requests,
checks that the capture is not clipped, writes compressed 2× WebP assets, and removes
the route when finished. Playwright is an external capture dependency, as with the
other scripts in this directory; it is not a product dependency.

The grouped Coolify / Dokploy guide uses the existing **Server or Docker** import.
Its provider marks come from the projects' own repositories:

- Coolify: `coollabsio/coolify`, `public/coolify-logo.svg`
- Dokploy: `Dokploy/dokploy`, `apps/dokploy/public/logo.svg`

The names and marks belong to their respective owners. Displaying them identifies
migration sources and does not imply endorsement.
