## A shared knowledge base

This template installs the stable Wiki.js 2 release with a private PostgreSQL database. It pulls pinned published images and stores attachments and application files on a persistent volume.

## First login

Choose the initial administrator's email. Openship generates and encrypts its password. The startup helper binds Wiki.js to container loopback while completing the upstream setup flow. It starts the public listener only after confirming that the administrator exists. An incomplete existing setup stops deployment rather than resetting accounts.

Find the initial credentials in **Connection**, then create pages and manage access in Wiki.js. Existing accounts and changed passwords are preserved on redeployment. Public reading follows Wiki.js's own permissions; review guest access before storing private documents.

## Storage and sizing

Allow at least 1 CPU core and 1.25 GiB RAM. These recommendations do not set runtime limits. Back up both the database and the Wiki.js data volume. Database credentials are generated once and shared securely between the two services; the database has no public endpoint.

[Wiki.js documentation](https://docs.requarks.io/) · [Stable source](https://github.com/requarks/wiki/tree/v2.5.315)
