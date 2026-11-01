# Scaling screenshots

These promotional images use client-side fixture data in the existing scaling
editor. They illustrate Commerce API on three servers, a PostgreSQL primary with
two read replicas, and a Redis cluster with three primary shards and one replica
per shard. They are visual examples, not observations of running infrastructure.

- `scaling-topology.png`: application routing and both database clusters.
- `postgres-replicas.png`: PostgreSQL replication view.
- `redis-cluster.png`: Redis shards, slot ranges, and replicas.

The matching `-zoomed.png` versions enlarge the canvas to 120% and tighten the
spacing between nodes. They retain the full interface and every node, with the
originals preserved. Add `--zoomed` to the capture command to regenerate them.

The `-ui-zoomed.png` versions enlarge the **entire interface** to the equivalent
of 125% browser zoom: navigation, text, buttons, and controls. They use a smaller
logical viewport with a higher pixel density, keeping the same 3200px width and
adding a little height (2400px) so the diagram stays readable. The topology uses
its original layout and fits automatically; its
Zoom in control is not used. Regenerate these with `--ui-zoomed`.

The capture uses the existing local dashboard, with no server or database
seeding. It creates an isolated browser profile and intercepts client API reads.
The development route is removed after capture; no preview route ships with the
application. The retained scaling editor is documented in
[its README](../../../apps/dashboard/src/components/scale/README.md).

To regenerate, keep the dashboard and API running normally, install Playwright
outside this repository (or use an existing installation), then run:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium \
node scripts/screenshots/scaling/capture.mjs
```

`SCREENSHOT_ORIGIN` defaults to `http://localhost:3001`. Images use the dashboard's
dim theme and existing fonts, icons, canvas, node cards, controls, and cluster
drill-downs. Original and canvas-zoomed PNGs are 3200 × 2160; interface-zoomed
PNGs are 3200 × 2400.
