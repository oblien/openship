## WordPress with its own control panel

This stack pulls the official WordPress Apache and MariaDB images directly. A small mounted setup script creates the generated owner account before the website starts accepting requests. Open **WordPress Admin** to manage content, themes, and plugins; Openship manages the deployment, routing, logs, and storage.

## First sign-in

Set a site title and administrator email during installation. The Connection card shows the administrator username and generated password. The public website and `/wp-admin/` share the same domain. Database credentials are separate from the administrator account, and MariaDB is private by default.

## Storage and maintenance

The WordPress files and database each use persistent volumes. Back up both together before upgrades or plugin changes. Redeployment keeps the existing administrator and content; it does not reset a password you changed in WordPress. The site URL follows the route selected in Openship.

Installation uses WordPress's built-in setup API and does not build a custom image or download WP-CLI. Use the official WordPress CLI image separately if you need WP-CLI tools. The stack does not include paid plugins, a mail delivery service, or a separate WordPress hosting panel. Configure outgoing email in WordPress when needed.

[WordPress Docker image](https://hub.docker.com/_/wordpress) · [WordPress administration](https://wordpress.org/documentation/article/administration-screens/)
