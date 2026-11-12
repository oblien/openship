# Localized product screenshots

The landing hero uses the current dashboard shell and deployment wizard with
Fullstack selected and the configuration open. The companion cards show build
logs and monitoring. All repositories, accounts, logs and metrics are sample data.
The product components, theme and translations are reused directly.
The capture omits the Webmail card to keep the framework grid at two rows,
omits the output directory field and summary value, and ends the deployment
card after the command fields so the environment card follows it. These
presentation choices apply only to the screenshot fixture.

The center capture keeps the original Mac image size: a 1499 × 786 viewport at
2× pixel density produces a 2998 × 1572 image. Walkthrough captures use a
900 × 675 viewport at 2×. The website retains its existing tilted card layout.

Start the dashboard dev server, then run from the repository root:

```sh
SCREENSHOT_ORIGIN=http://localhost:3001 node scripts/screenshots/landing/capture.mjs
SCREENSHOT_ORIGIN=http://localhost:3001 node scripts/screenshots/deploy-walkthrough/capture.mjs
```

The scripts require Playwright Chromium and Sharp. When Playwright is installed
outside this workspace, set `PLAYWRIGHT_MODULE` to its entry point. Both scripts
use the supported locales from `packages/core/src/locale.ts`; no second language
list is maintained. Optional environment variables:

- `SCREENSHOT_LOCALES=en,ar`: capture only these languages.
- `SCREENSHOT_OUTPUT=/tmp/openship-screenshots`: preview without replacing public assets.

Outputs are in `apps/web/public/screenshots/<locale>/`: `deploy.webp` and
`walkthrough/<stage>[-light].webp`. The English wizard also replaces
`apps/web/public/screen.png` and `docs/screenshots/screen.png`, used by the README.
Existing translated READMEs reference their language's WebP directly. The Korean
README retains the English fallback because the dashboard has no Korean locale.
The English walkthrough JPEGs remain available at their existing paths.

Each capture uses a separate browser context, the dashboard's locale and theme
preferences, and real UI interactions. API requests are intercepted with sample
responses; deployment methods reject calls. Temporary development-only routes
are removed when the scripts exit. Captures verify language, direction, theme,
image decoding, absence of browser errors and absence of API mutations.

The marketing site's shared `localizedScreenshot` helper selects assets using
the current page locale. Images are static files: selecting a language does not
capture screens or fetch dashboard data in production.
