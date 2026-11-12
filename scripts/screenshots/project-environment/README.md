# Project environment review

This is the historical baseline for the first editor consolidation. The current
interactive preview and capture workflow is [project-consistency](../project-consistency/README.md).
Keep these `before-*` artifacts for the comparison; this older capture script describes
the earlier card-based UI.

The capture uses real dashboard components and a synthetic single-app project. Browser API
calls are intercepted; environment edits and deploy requests only update the fixture.
The temporary development route is removed on completion.

With the dashboard dev server running, execute from the repository root:

```sh
SCREENSHOT_ORIGIN=http://localhost:3001 \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
node scripts/screenshots/project-environment/capture.mjs
node scripts/screenshots/project-environment/review.mjs
```

`SCREENSHOT_OUTPUT` changes the default `artifacts/project-environment` destination.
`PLAYWRIGHT_CHROMIUM_EXECUTABLE` optionally selects an installed browser.

The retained `before-*` images were captured before the editor consolidation. To capture
another baseline, use `SCREENSHOT_PHASE=before` with the baseline source checked out.
Running the default after capture preserves the existing before images.

The browser checks cover secret preservation, separate Save and Apply operations, reopening
Settings, static/Cloud rebuild behavior, themes, and mobile/Arabic overflow. They validate
browser requests and UI behavior; they do not execute a deployment on a real host.
