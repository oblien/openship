## Documents with OCR

Paperless-ngx archives original documents, extracts searchable text, and organizes files with tags and correspondents. This template uses pinned upstream images for Paperless, PostgreSQL, and Valkey. There is no installation-time image build.

## First login

Choose the initial administrator's username and email. Openship generates and encrypts the password and signing secret. Paperless creates the administrator through its native startup support before serving its website. Open **Connection** after deployment to retrieve the initial credentials. Changing a password in Paperless is preserved across redeployments.

## Storage and sizing

Allow at least 2 CPU cores and about 2.25 GiB RAM; OCR of large files needs more. Resource profiles are recommendations, not container limits. The database, media, data, consume, and export folders have separate project-scoped volumes. Back up the database and original documents together.

Upload documents in the web UI, or copy files to the consume volume. English OCR and UTC are the initial defaults; configure supported OCR languages and timezone in the app's environment. Optional Tika and Gotenberg services for Office documents are not included. Neither PostgreSQL nor the queue is publicly exposed.

[Upstream configuration](https://docs.paperless-ngx.com/configuration/) · [Source and releases](https://github.com/paperless-ngx/paperless-ngx)
