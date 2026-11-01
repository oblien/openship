## A dashboard for your services

Homepage organizes links, bookmarks, and optional integration widgets. This template pulls the published Homepage image and adds a small Caddy authentication proxy, because Homepage has no built-in user authentication.

## Protected access

Choose a dashboard username. Openship generates and encrypts a password, shown in **Connection**. The browser asks for these credentials before any page or API response is served. Only the proxy receives a public route; Homepage stays on the private project network with a specific host allowlist. No Docker socket, host filesystem, or Kubernetes credentials are mounted.

Manage the access username and password through Openship configuration. These are proxy credentials, not a Homepage administrator account.

## Configure the dashboard

The persistent config volume contains `settings.yaml`, `services.yaml`, `bookmarks.yaml`, and `widgets.yaml`. Initial empty files are created only when missing, so your changes survive redeployments. Edit them through the service's files or terminal tools. Add integration credentials only for services you trust; keep the dashboard password-protected.

Allow about 512 MiB RAM and at least 0.5 CPU cores. These are sizing recommendations, not container limits. Back up the config volume.

[Homepage configuration](https://gethomepage.dev/configs/) · [Container installation](https://gethomepage.dev/installation/docker/)
