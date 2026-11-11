FROM debian:12-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d \
    && chmod +x /usr/sbin/policy-rc.d \
    && apt-get update && apt-get install -y --no-install-recommends \
      supervisor rsyslog cron logrotate clamav-freshclam fail2ban sqlite3 \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/fail2ban/jail.d/defaults-debian.conf \
    && sed -i 's/^MaxAttempts .*/MaxAttempts 1/' /etc/clamav/freshclam.conf
COPY apps/email/docker/prepare-mail-logs.sh apps/email/docker/rsyslog-rotate apps/email/docker/logrotate-clamav-freshclam /opt/openship-mail/
RUN install -m 0755 /opt/openship-mail/rsyslog-rotate /usr/lib/rsyslog/rsyslog-rotate \
    && install -m 0644 /opt/openship-mail/logrotate-clamav-freshclam /etc/logrotate.d/clamav-freshclam
COPY apps/email/engine/samples/logrotate/dovecot /etc/logrotate.d/dovecot
COPY apps/email/docker/build-config /tmp/build-config
RUN . /tmp/build-config; \
    sed -i "s@PH_DOVECOT_LOG_DIR@/var/log/dovecot@g; s@PH_SYSLOG_POSTROTATE_CMD@$SYSLOG_POSTROTATE_CMD@g" /etc/logrotate.d/dovecot
COPY apps/api/test/e2e/fixtures/mail-state/supervisord.conf /opt/openship-mail/supervisord.conf
COPY apps/api/test/e2e/fixtures/mail-state/start.sh /start.sh
RUN printf 'module(load="imuxsock")\nlocal5.* /var/log/dovecot/dovecot.log\n' > /etc/rsyslog.conf \
    && printf '[review]\nenabled = true\nbackend = polling\nfilter = review\naction = review\nlogpath = /var/log/mail.log\nbantime = 3600\n' > /etc/fail2ban/jail.local \
    && printf '[Definition]\nfailregex = ^failed <HOST>$\n' > /etc/fail2ban/filter.d/review.conf \
    && printf '[Definition]\nactionstart = true\nactionstop = true\nactionban = true\nactionunban = true\n' > /etc/fail2ban/action.d/review.conf
CMD ["bash", "/start.sh"]
