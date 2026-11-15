FROM oven/bun:1.4.4 AS bun
FROM debian:12-slim
ENV DEBIAN_FRONTEND=noninteractive container=docker
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod +x /usr/sbin/policy-rc.d \
    && apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv sudo postgresql dovecot-core dovecot-imapd \
      postfix amavisd-new zstd curl ca-certificates openssl netcat-openbsd \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 2000 vmail && useradd -u 2000 -g vmail -d /var/vmail vmail
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server dovecot-pgsql \
    && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
