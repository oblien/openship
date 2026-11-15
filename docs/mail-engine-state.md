# Mail engine state during updates

Mail logs and fail2ban's SQLite history are retained under
`/var/lib/openship/mail/logs` and `/var/lib/openship/mail/fail2ban`. The PostgreSQL
sidecar, mailbox data, mail queue, DKIM keys and existing configuration retain
their established mounts.

The first update from an older container preserves its writable-layer logs and
SQLite database before removing it. OpenShip obtains the replacement image first,
stops the old engine to get a consistent snapshot, copies both directories, then
publishes the host directories. Subsequent updates reuse these mounts without
copying or stopping the container during preservation checks.

If preservation fails, the original container is retained and its previous run
state is restored. Existing nonempty host data and custom mounts are never merged
or replaced automatically; the update reports the conflicting path for an operator
to reconcile. The existing image rollback uses the same retained data.

The entrypoint creates daemon log directories on every boot, including ClamAV's
directory, and repairs their service ownership after image UID changes. Native
logrotate policies are run by cron. Rsyslog and Freshclam reopen their logs through
Supervisor rather than relying on systemd or Debian's service-start policy.

## Operator fail2ban exclusions

`OPENSHIP_MAIL_F2B_IGNOREIP` extends the image's default `ignoreip` list. For a new
installation, an operator may set it in the API environment before mail setup.
For an existing server, set the single-line value in that server's retained
`/var/lib/openship/mail/engine.env`, then update/recreate the engine. Different
servers can retain different exclusions. The file contains credentials and must
remain private.

Move existing manual `ignoreip` edits from the old container into this setting
before the first update. Arbitrary files under `/etc/fail2ban` are not persisted;
retaining the entire directory would hide fixes in newer images. The entrypoint
renders the supported exclusions on each boot while retaining the baked defaults.
Newlines, shell substitutions and configuration section delimiters are rejected.
