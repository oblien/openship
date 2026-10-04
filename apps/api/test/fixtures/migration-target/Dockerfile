FROM docker:28-dind

RUN apk add --no-cache openssh-server openssl curl && \
    ssh-keygen -A && mkdir -p /root/.ssh && chmod 700 /root/.ssh && \
    passwd -d root
COPY start.sh /usr/local/bin/migration-target
RUN chmod +x /usr/local/bin/migration-target
EXPOSE 22
# Prepare nested cgroups with the image's own wrapper before either daemon starts.
ENTRYPOINT ["/usr/local/bin/dind", "/usr/local/bin/migration-target"]
