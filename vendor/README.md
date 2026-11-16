# Pinned client package

The dashboard and mail client use `@mindwire-ai/client` version `0.1.0-beta.3`
from `mindwire-client-0.1.0-beta.3-83f1a8478412.tgz`. This archive matches the
locally validated package and includes its MIT license. Keeping it here makes
the `file:` dependencies reproducible without a sibling checkout or a temporary
machine-specific path.

SHA-256: `83f1a847841212f6406840cbc1b1914339978699db354166ce154dbcc7b5ab26`.

Source project: [oblien/mindwire](https://github.com/oblien/mindwire),
`packages/client`.

Both consumers apply `patches/mindwire-client-0.1.0-beta.3-same-origin.patch`
through Bun's `patchedDependencies`. It changes the optional vision client's
default URL to the browser's current origin, while preserving an explicitly
configured `visionUrl`. The upstream bundle otherwise contains fixed development
ports, including `localhost:5020`, which fails the mail release's dev-origin check.
The archive and checksum above remain unchanged.
