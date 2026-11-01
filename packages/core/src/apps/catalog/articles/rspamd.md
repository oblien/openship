## Connect your mail server

Rspamd provides HTTP message scanning at `http://rspamd:11333/checkv2` and a milter endpoint at `rspamd:11332` on the project's private network. Configure your mail server to use the appropriate worker. This template runs one Rspamd service and preserves its state in `/var/lib/rspamd`.

Some features, including greylisting and rate limits, require Redis. Install and configure an external Redis server to use those features; this template does not bundle one.

## Controller login

Open the controller UI from **Connection** and use the generated controller password; there is no username. Only controller port 11334 has a public route. Both read and write controller operations require the password, including requests from loopback or a reverse proxy. The `/ping` health endpoint and static login page remain publicly readable.

The startup helper hashes the password with Rspamd's own utility before starting the server. The controller configuration receives only that hash. File and shared-memory message inputs are disabled on the controller. Openship 0.9.2 or newer is required for the startup entrypoint override.

Change `RSPAMD_CONTROLLER_PASSWORD` in the app's environment and redeploy to rotate controller access. Back up the `/var/lib/rspamd` volume to preserve learned data and caches.

[Official Docker image guide](https://github.com/rspamd/rspamd-docker) · [Controller documentation](https://docs.rspamd.com/workers/controller/)
