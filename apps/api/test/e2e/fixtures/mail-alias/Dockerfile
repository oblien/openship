FROM debian:12-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      postfix postfix-pgsql dovecot-core postgresql-client \
      python3 python3-sqlalchemy python3-psycopg2 python3-requests \
      python3-dnspython python3-multipart curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG IREDAPD_VERSION=6.1
RUN curl --fail --location --retry 3 \
      "https://codeload.github.com/iredmail/iRedAPD/tar.gz/refs/tags/${IREDAPD_VERSION}" \
      | tar -xz -C /opt \
    && ln -s "/opt/iRedAPD-${IREDAPD_VERSION}" /opt/iredapd
COPY apps/email/docker/sender_aliases.py apps/email/docker/reconcile-db-port.py /opt/openship-mail/
COPY apps/email/engine/samples/postfix/pgsql/sender_login_maps.cf /opt/iRedMail-engine/samples/postfix/pgsql/
COPY apps/email/engine/samples/iredmail/iredmail.pgsql /schema.sql
RUN python3 /opt/openship-mail/sender_aliases.py \
      /opt/iredapd/plugins/reject_sender_login_mismatch.py \
      /opt/iRedMail-engine/samples/postfix/pgsql/sender_login_maps.cf
CMD ["sleep", "1800"]
