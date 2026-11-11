#!/bin/bash
set -euo pipefail
bash /opt/openship-mail/prepare-mail-logs.sh
exec /usr/bin/supervisord -c /opt/openship-mail/supervisord.conf
