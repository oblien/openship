## Private antivirus scanning

ClamAV runs `clamd` and `freshclam` together using the official pinned Debian image. Applications on the project's private network can stream files to `clamav:3310`. The scanner has no authentication or encryption, so this template keeps it internal and publishes no host port or public route.

## Signatures and resources

The `/var/lib/clamav` volume preserves signature databases across deployments. Freshclam updates them automatically. Startup may take several minutes while signatures are downloaded or loaded; the health check allows a ten-minute startup period.

Allow at least 3 GiB of RAM; 4 GiB is recommended because database reloads temporarily increase memory use. The template recommends 2 CPU cores, 4 GiB RAM, and 8 GiB disk. Back up the volume if retaining your signature database is important to your recovery plan.

[Official Docker guide](https://docs.clamav.net/manual/Installing/Docker.html) · [ClamAV source](https://github.com/Cisco-Talos/clamav)
