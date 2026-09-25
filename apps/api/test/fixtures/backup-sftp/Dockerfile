FROM alpine:3
RUN apk add --no-cache openssh-server && \
    adduser -D backup && echo 'backup:release-test-password' | chpasswd
EXPOSE 2222
CMD ["sh", "-ec", "ssh-keygen -A >/dev/null; mkdir -p /run/sshd /home/backup/backups; chown backup:backup /home/backup/backups; exec /usr/sbin/sshd -D -e -f /dev/null -p 2222 -o 'PasswordAuthentication yes' -o 'Subsystem sftp internal-sftp'"]
