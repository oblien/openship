# syntax=docker/dockerfile:1
# ─── openship-edge ──────────────────────────────────────────────────────────
# The routing/TLS edge, run as a CONTAINER on :80/:443 (network_mode: host)
# instead of bare OpenResty on the host. Cleaner than apt-installing OpenResty +
# certbot on the box: the edge ships as an image.
#
# The api container drives this edge via the Docker socket (see
# DockerEdgeExecutor): it drops vhost `<slug>.conf` files into the shared
# sites-enabled volume and runs `openresty -s reload` / `certbot` via
# `docker exec`. Three dirs are SHARED VOLUMES (api writes, edge reads):
#   • /usr/local/openresty/nginx/conf/sites-enabled  — managed vhosts
#   • /etc/letsencrypt                                — issued certs
#   • /var/www/acme                                   — ACME http-01 webroot
# nginx.conf + the openship Lua are BAKED here (complete, no runtime edits), so
# the api never installs OpenResty or Lua in docker mode.
# ─────────────────────────────────────────────────────────────────────────────
FROM openresty/openresty:1.27.1.1-alpine

# certbot → managed TLS via http-01 (served from the webroot below).
# procps → `pkill` for the reload command's restart fallback.
# curl   → optional GeoLite2 download (geo is non-fatal if absent).
RUN apk add --no-cache certbot procps curl

# Openship Lua (rules engine + analytics + logging + webhook). Baked in at the
# path lua_package_path resolves (`require "openship.rules_lib"` etc.).
COPY packages/adapters/src/infra/lua/ /usr/local/openresty/site/lualib/openship/

# Complete config: shared dicts, lua path, ACME/default catch-all, the loopback
# management API, and the dynamic sites-enabled include. No runtime sed.
COPY apps/edge/nginx.conf /usr/local/openresty/nginx/conf/nginx.conf

# Create the shared-volume mount points so a first boot (before the api writes
# anything) still validates + starts.
RUN mkdir -p /usr/local/openresty/nginx/conf/sites-enabled /var/www/acme /etc/letsencrypt

EXPOSE 80 443
# Graceful OpenResty stop.
STOPSIGNAL SIGQUIT
CMD ["openresty", "-g", "daemon off;"]
