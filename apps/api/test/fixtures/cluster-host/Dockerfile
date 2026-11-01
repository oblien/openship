FROM ubuntu:24.04

# iSCSI's kernel control socket exists only in the initial network namespace.
# Docker network namespaces cannot model independent storage hosts. Keep the
# disposable Docker transport, but boot a real Linux kernel for every server.
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    qemu-system-x86 qemu-utils cloud-image-utils iproute2 python3 \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir /image && cd /image \
    && curl -fSL --retry 3 https://cloud-images.ubuntu.com/noble/current/SHA256SUMS -o SHA256SUMS \
    && curl -fSL --retry 3 https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img -o noble-server-cloudimg-amd64.img \
    && grep ' \*noble-server-cloudimg-amd64.img$' SHA256SUMS | sha256sum -c -
COPY boot.py /boot.py
ENTRYPOINT ["python3", "/boot.py"]
