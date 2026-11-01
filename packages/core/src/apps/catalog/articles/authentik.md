## Authentik identity provider

This stack follows Authentik's server, worker, and PostgreSQL composition. The server and worker share a generated signing key and database credentials. The worker initializes the `akadmin` account with a generated password and your chosen email. Open Authentik from the Connection card.

## Set up your applications

Create providers and applications in Authentik, then configure each application's redirect URIs and credentials. Installing an identity provider does not automatically connect Openship's own login or your other applications to it. Configure SMTP in Authentik for invitations and password resets.

## Outposts and storage

The stack does not mount the host Docker socket or grant the worker host administration access. Use the embedded proxy outpost or deploy additional outposts manually; automatic Docker outpost deployment is unavailable. The database, uploaded data, templates, and certificates persist in project-scoped volumes.

Bootstrap credentials only apply to an empty installation. Accounts changed in Authentik remain unchanged on redeployment. Back up the database and data together before upgrades, and follow Authentik's release-specific migration instructions.

[Docker Compose installation](https://docs.goauthentik.io/install-config/install/docker-compose/) · [Automated installation](https://docs.goauthentik.io/install-config/automated-install)
