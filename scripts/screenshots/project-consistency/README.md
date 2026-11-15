# Apps & Services preview

This preview runs the real dashboard components against an in-memory fixture API.
It copies the dashboard into the ignored `artifacts/project-consistency/preview-app`
directory, removes its production routes, and installs only sample project routes.
It does not change the running dashboard or deploy anything.

From the repository root, prepare the copy:

```sh
node scripts/screenshots/project-consistency/prepare.mjs
```

Run these in separate terminals. The explicit IPv4 URL avoids other local servers
that may be listening on `localhost` through IPv6:

```sh
node scripts/screenshots/project-consistency/fixture.mjs
```

```sh
OPENSHIP_LOCAL_API_URL=http://127.0.0.1:3013 \
INTERNAL_API_URL=http://127.0.0.1:3013 \
node node_modules/next/dist/bin/next dev artifacts/project-consistency/preview-app \
  --port 3012 --hostname 127.0.0.1
```

Open <http://127.0.0.1:3012/projects/environment-preview/services>.
The toolbar switches between a single app and the same app with PostgreSQL.
The normal Add form, app/service switcher, tabs, and environment Save/Apply controls
are interactive. The fixture has no production credentials or live deployment engine;
unsupported operations report that they are outside the preview.

Domain cards also include the real **Virtual routes** editor. Create, edit, pause, and
remove sample responses under `/projects/environment-preview/services/application/domains`.
The fixture keeps these changes in memory and simulates edge acknowledgement; actual HTTP
response behavior is covered by the isolated OpenResty routing E2E suite.
Set `PREVIEW_API_PORT` and the two API URL variables above to use a different fixture port.

Capture the walkthrough and theme/mobile checks with an installed Playwright:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome-headless-shell \
node scripts/screenshots/project-consistency/capture.mjs
node scripts/screenshots/project-consistency/review.mjs
```

Run `response-routes.mjs` in the same directory with those Playwright variables for
the virtual-route editor checks and local captures. `PREVIEW_ORIGIN` and
`PREVIEW_API_ORIGIN` override its default preview and fixture addresses. It checks
create/edit/pause/remove, failed-save recovery, adding a service, themes, and mobile.

The capture uses the real Add form to add PostgreSQL, verifies the stable application
URL and saved environment, preserves untouched secrets, and checks separate Save/Apply,
local tabs, inline configuration saving without deployment, permanent Settings ownership,
app route scope, all three themes, and English/Arabic mobile widths.
Generated screenshots and comparison data are local-only under the ignored `artifacts/` directory.
Before images appear in the gallery when a local baseline capture is available.

The cleanup comparisons also include app configuration before/after, project Settings
before and after adding PostgreSQL, and direct inline environment editing for the app. Project Settings opens the same
environment component for shared values. `ApplicationSettingsForm` adapts the flat save API response to the
page context and renders the existing wizard fields; it does not define a second field set.
