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

Capture the walkthrough and theme/mobile checks with an installed Playwright:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome-headless-shell \
node scripts/screenshots/project-consistency/capture.mjs
node scripts/screenshots/project-consistency/review.mjs
```

The capture uses the real Add form to add PostgreSQL, verifies the stable application
URL and saved environment, preserves untouched secrets, and checks separate Save/Apply,
local tabs, shared Settings scope, all three themes, and English/Arabic mobile widths.
The original before images are retained from `artifacts/project-environment`.
