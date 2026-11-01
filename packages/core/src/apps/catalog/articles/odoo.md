## Odoo Community

Run the official Odoo Community image with a dedicated PostgreSQL database. Both images are pulled directly, with no custom image build. A mounted setup script initializes the `odoo` database and generated administrator account before starting the web server. Sign in from the Connection card and install the Community modules your business needs.

## Access and data

The administrator email is chosen during installation. The password is generated separately from the PostgreSQL and database master passwords. The web database manager is disabled; PostgreSQL is private. The image uses Odoo's proxy mode behind Openship's routing.

Database records, the filestore, and custom addons use persistent volumes. Back up the database and filestore together. Redeployment preserves existing accounts and data. If initial database creation fails, the deployment fails and retains the database for diagnosis; it never drops or recreates an existing database automatically.

## Community and Enterprise

This is the open-source Community edition. Enterprise modules and features require an Odoo license and are not included. Outgoing email, external payment providers, and your business workflows still need configuration within Odoo. Major-version upgrades require an Odoo migration; replacing the image is not a database migration.

[Official Odoo image](https://hub.docker.com/_/odoo) · [Odoo Community source](https://github.com/odoo/odoo)
