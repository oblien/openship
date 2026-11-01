## Nextcloud file sync and sharing

Run the official Nextcloud Apache image with a dedicated MariaDB database, Redis file locking, and a background-job container. The initial `admin` account receives a generated password. Open Nextcloud from the Connection card to create users and configure sharing.

## Routing

Only Nextcloud receives a domain by default. The selected URL drives trusted-domain, host, and protocol configuration; it works with Openship Cloud and self-hosted routing without assuming that every route uses HTTPS. Use the configured route for access. A local tunnel does not change Nextcloud's canonical URL or trusted domains.

## Data and maintenance

Nextcloud files, application configuration, database, and Redis state use persistent volumes. The web and cron services share the same Nextcloud data volume. The required setup step enables cron mode after installation. Back up the database and files together. The generated admin password initializes an empty installation; it does not reset a password changed in Nextcloud.

This is the standard Nextcloud server stack. Nextcloud Talk's high-performance backend, office document servers, antivirus scanning, external storage, and SMTP are separate integrations. Upgrade one supported major version at a time following Nextcloud's upgrade guide.

[Official Nextcloud image](https://hub.docker.com/_/nextcloud) · [Reverse proxy configuration](https://docs.nextcloud.com/server/stable/admin_manual/configuration_server/reverse_proxy_configuration.html)
