The startup screen bundles the same Gellix fonts used by the dashboard so it can
render before the local server starts, including when the machine is offline.

Sources (also referenced by `apps/dashboard/src/styles/fonts.css`):

- https://cdn.oblien.com/fonts/Gellix-Regular.woff2
- https://cdn.oblien.com/fonts/Gellix-Medium.woff2

The desktop build inlines these files as data URLs; no startup request is made to
the CDN.
