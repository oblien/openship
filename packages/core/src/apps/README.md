# Apps — the curated catalog

This directory is Openship's **App catalog**: the one-click installs in the dashboard's **Apps** tab.
An App is **metadata over the normal services deploy** — it already knows the images, how the
services wire together, which secrets to generate (and keep in sync), what to expose, and what to
show afterwards. Same engine underneath (a repo-less `services` project marked `isApp`); a much
shorter path for the user.

Two kinds: **`template`** instantiates the `services` in the entry (the common case), while
**`flow`** just points at a bespoke wizard via `flowHref` (e.g. the mail stack → `/emails`) and
declares no services.

## 📖 The documentation lives on the docs site

**Do not document fields here** — the docs site is canonical, so there is nothing to drift:

- **[Field reference](https://openship.io/docs/reference/app-catalog)** — every authorable field,
  the `configFields`-vs-`settings` distinction, placeholders, validation rules, and versioning.
- **[Add an app](https://openship.io/docs/guides/add-an-app)** — the step-by-step, the review bar,
  worked examples, and the checklist.
- **[Apps API](https://openship.io/docs/api/apps)** — catalog, install, custom apps, settings,
  connection.

## Files here

| Path | What it is |
|---|---|
| [`catalog/`](./catalog/) | Catalog source — one JSON per app, `<id>.json`. **Edit these.** |
| [`catalog.json`](./catalog.json) | Merged artifact the bundle imports and the API serves. Generated. |
| [`schema.ts`](./schema.ts) | The authoritative validator (shape + referential + version gate). |
| [`../../scripts/gen-catalog.ts`](../../scripts/gen-catalog.ts) | Builds `catalog.json` from `catalog/*.json`. |
| [`../app-templates.ts`](../app-templates.ts) · [`../app-settings.ts`](../app-settings.ts) | The TypeScript types. |

The published JSON Schema mirroring `schema.ts` is at
[`apps/web/public/app.schema.json`](../../../../apps/web/public/app.schema.json) (served as
`https://openship.io/app.schema.json`). **Keep it in sync when you change `schema.ts`** — add
`"$schema": "https://openship.io/app.schema.json"` to a catalog file for editor autocomplete.

## After editing a catalog file

```bash
cd packages/core
bun scripts/gen-catalog.ts                  # regenerate catalog.json (a drift test fails CI without this)
bunx vitest run src/apps/catalog.test.ts    # assert sync + every app passes the full schema
```
