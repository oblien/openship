Marketing translations use the shared `APP_LOCALES` list and next-intl. English keeps its existing URLs; other languages use `/ar`, `/fr`, and so on. Explicit URLs determine the language, so crawlers and caches receive the same content regardless of browser preferences or cookies.

`routing.ts` owns language URLs and the marketing scope. Documentation retains its source URLs and language. Blog articles use native Fumadocs language files (`article.ar.mdx`, etc.); release notes use cached public content with translated text nodes. Marketing links use `i18n/Link` to retain the current locale; external and documentation links remain unchanged.

Legal translations preserve the source policy and terms; update them together when the English text changes.

Use `useCopy()` in shared synchronous presentation components and client components, and `await getCopy()` in async server components or metadata functions. English source phrases stay readable at the call site. `messageKey(source)` maps normalized source text to its stable catalog key. Add or update that key in every `messages/<locale>.json` file when changing copy. For variable text, translate the whole sentence with ICU placeholders, rather than interpolating English before translation. Use `copy.rich()` for sentences containing links or emphasis. Never translate route IDs, enum values, commands, credentials or configuration data.

Catalogs are bundled with the website. Translation does not make network requests at runtime. Server rendering loads the requested catalog, and the client receives that same locale. Release prose lives in `ReleaseNotes` and is merged into server translations without being sent to every visitor. New or changed release prose falls back to English until its catalog translations are added. Public pricing uses the existing API and cache, including its locale parameter; prices and checkout identifiers remain unchanged.

Use OpenShip casing for display branding. Message keys normalize the older casing so cached release content still finds its translations. Product, framework and runtime names retain their English names; render catalog names directly instead of passing them through translation. Isolate embedded prices and Latin provider names with `bdi` in RTL layouts. Use logical CSS properties for directional spacing, borders and column highlights.

Run `bun run --cwd apps/web test` for URL and catalog integrity checks, and `bun run --cwd apps/web test:metadata` after a production build for rendered metadata and social previews.
