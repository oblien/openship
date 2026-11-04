# Server advisory review

These captures use the real dashboard components and explicitly synthetic server
and API data. Every API request is intercepted; no host commands or notifications run.

- [Package review](review-patch.png), [mobile](review-patch-mobile.png)
- [Verified run steps and output](verified-run.png), [mobile](verified-run-mobile.png)
- [Separate reboot review](review-reboot.png)
- [Monitoring inspection task](monitoring-task.png)
- [Browser checks](browser-checks.json)

Run a dashboard development server, then:

```sh
SCREENSHOT_ORIGIN=http://localhost:3001 \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
node scripts/screenshots/server-security/capture.mjs
```

Optionally set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to an installed browser. The script
creates its own development-only route and removes it in `finally`. It checks no
mutation on page load, explicit plan/apply, reviewed dependencies, mobile overflow,
run steps and terminal output, a shared read-only completion stream, separate reboot approval and visible task status, with no page errors.
