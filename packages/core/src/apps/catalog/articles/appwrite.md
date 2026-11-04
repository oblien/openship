# Appwrite

Deploy an Appwrite 2.7.0 backend with the Console, API, combined worker, scheduler,
and Realtime service. PostgreSQL, MongoDB, Redis, and ClickHouse stay private on
the project network. Storage and database state use project-scoped named volumes.
The gateway serves the Console and `/v1` API on one OpenShip domain.

## First login

Choose the owner's email during installation. OpenShip generates the initial
password and creates that owner before the public gateway starts. Sign in using
the connection panel, then create your organization and project in the Console.
Only the first Console owner can register; invite additional team members through
Appwrite. Redeploying preserves accounts and passwords.

## Included services

Auth, TablesDB, DocumentsDB, VectorsDB, file Storage, Realtime, and usage statistics
are included. Configure your own SMTP server in the Appwrite API and worker before
using password recovery, invitations, or email messaging. Keep the domain stable;
update `OPENSHIP_PUBLIC_URL` across the Appwrite services if you change it.

Functions and Sites require Appwrite's Docker executor, runtime networks, and
wildcard routing. Those runtime services are not included in this catalog recipe.
Embedding model execution also requires an additional model service. Use the
[official installation guide](https://appwrite.io/docs/advanced/self-hosting/installation)
for those deployments; this recipe does not mount the host Docker socket or create
unmanaged sibling workloads.

## Resources and maintenance

Use at least 2 CPU cores, 4 GB RAM, and 10 GB free disk; allow more for application
traffic and stored files. Back up the database and storage volumes together, and
review Appwrite's upgrade instructions before changing versions. The encryption
key is generated once and must be retained with your backups.

MongoDB initialization and ClickHouse retention helpers are taken from the
[Appwrite 2.7.0 distribution](https://github.com/appwrite/appwrite/tree/2.7.0).
