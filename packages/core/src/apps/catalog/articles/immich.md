## Photos and videos on your server

Immich backs up and organizes photos and videos. This template follows the pinned release's upstream stack: matching server and machine-learning images, Valkey, and the supported vector-enabled PostgreSQL image. No customer-side image build is required.

## First login

Choose the initial administrator's email and display name. Openship generates and encrypts the password. Registration runs against a loopback-only startup listener; public access starts only after the owner exists, with unauthenticated setup disabled. Changed account details and passwords survive redeployment. Retrieve the initial credentials in **Connection** and use the same server address in Immich's mobile app.

## Requirements and storage

Provide at least 2 CPU cores and 6 GiB RAM; Immich recommends 8 GiB or more. Current AMD64 machine-learning images require an x86-64-v2 CPU. ARM64 is supported. The template uses software processing, without GPU devices or privileged container access. Recommendations do not impose container limits.

Photos, database contents, and downloaded machine-learning models have separate persistent volumes. Keep the database on local Linux-compatible storage, preferably SSD. Model downloads require internet access and may take time when processing the first photos. Back up the database and uploaded media together; this installation is not a substitute for a separate backup.

[Official requirements](https://docs.immich.app/install/requirements/) · [Release stack](https://github.com/immich-app/immich/blob/v3.3.1/docker/docker-compose.yml) · [Mobile setup](https://docs.immich.app/overview/quick-start/)
