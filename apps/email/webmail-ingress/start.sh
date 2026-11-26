#!/bin/sh
set -eu
# Substitute only operator settings. All nginx variables are evaluated per connection.
printf '%s\n' "$FLEET_DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
printf '%s\n' "$DNS_RESOLVER" | grep -Eq '^[0-9]+(\.[0-9]+){3}(:[0-9]+)?$'
FLEET_PATTERN=$(printf '%s' "$FLEET_DOMAIN" | sed 's/\./[.]/g')
export FLEET_PATTERN
envsubst '${FLEET_PATTERN} ${FLEET_DOMAIN} ${DNS_RESOLVER}' < /etc/nginx/webmail.conf.template > /tmp/webmail-nginx.conf
exec nginx -c /tmp/webmail-nginx.conf -g 'daemon off;'
