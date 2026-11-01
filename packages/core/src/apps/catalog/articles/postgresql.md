## PostgreSQL with pgAdmin

This stack includes PostgreSQL and the pgAdmin project's own container. PostgreSQL stays on the private project network; pgAdmin has a separate generated login and can use an Openship domain.

## Connect

The Connection card contains the private `DATABASE_URL`, application password, database administrator password, and pgAdmin credentials. pgAdmin is preloaded with the `openship` administrator; enter its separate database administrator password when connecting. Its login password does not grant database access by itself. Use **Use in a project** for application connections or **Open in localhost** for a local client.

The `app` role owns the application database and cannot administer roles or create databases. Its password and the `DATABASE_URL` are separate from the `openship` instance administrator. Create additional restricted roles in pgAdmin when needed. The stack does not expose PostgreSQL publicly or configure public PostgreSQL TLS.

## Access without a domain

Choose **Port only (no domain)** for pgAdmin during installation to use server port 5050 without a hostname or Openship Cloud connection. This explicitly publishes the pgAdmin web UI on that port. PostgreSQL stays on the private project network. Domain routing remains the default and can be selected instead.

## Persistence and backups

The database and pgAdmin configuration have separate persistent volumes. Take a database backup before upgrades. Changing PostgreSQL major versions requires migration or dump/restore; changing the image tag alone is insufficient.

[PostgreSQL image](https://hub.docker.com/_/postgres) · [pgAdmin container deployment](https://www.pgadmin.org/docs/pgadmin4/latest/container_deployment.html)
