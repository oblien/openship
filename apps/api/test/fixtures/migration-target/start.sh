#!/bin/sh
set -eu

chown -R root:root /root/.ssh
chmod 700 /root/.ssh
chmod 600 /root/.ssh/authorized_keys

# This daemon belongs only to the disposable test target. No host socket or
# host directory is mounted; takeover can safely own its ports 80 and 443.
dockerd --host=unix:///var/run/docker.sock > /tmp/dockerd.log 2>&1 &
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then
    exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o PermitRootLogin=prohibit-password \
      -o DisableForwarding=no -o AllowTcpForwarding=yes -o AllowStreamLocalForwarding=yes
  fi
  sleep 1
done
cat /tmp/dockerd.log
exit 1
