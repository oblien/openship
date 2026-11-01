## MariaDB with Adminer

Run a private MariaDB database and the official Adminer container. The application database is `app`, with the user `openship` and a generated password. The root account has a different generated password.

## Browser administration

Open Adminer from the Connection card. Choose **MySQL**, use the preselected **MariaDB** server, and sign in with the database username and password. Adminer uses database authentication rather than a separate dashboard account. Its official login-server plugin restricts the browser to this stack’s database. The application user can manage the `app` database; use the root account deliberately for instance-wide administration.

## Application connections

Use the private `DATABASE_URL` through **Use in a project**, or **Open in localhost** for your database client. Port 3306 is private by default. The database persists across container replacement; Adminer is stateless. Back up the database before changing its version.

[MariaDB image](https://hub.docker.com/_/mariadb) · [Adminer image](https://hub.docker.com/_/adminer)
