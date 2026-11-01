# NVIDIA GPU containers

Deploy GPU workloads to a Docker server that already has NVIDIA hardware, a compatible host driver,
and the NVIDIA Container Toolkit. This feature configures device access; it does not add GPU capacity
to managed Cloud server plans. The server GPU card reports the daemon's signal and lets an operator
correct detection. Its manual mark is a placement hint, not a reservation or access-control policy.

Use Compose device reservations or `gpus: all`. Every request group is preserved, including specific
NVIDIA device IDs, counts and driver options. Unrelated host CDI devices are refused. For example:

```yaml
services:
  inference:
    image: your-compatible-cuda-image:version
    gpus:
      - driver: nvidia
        device_ids: ["0"]
```

The legacy `runtime: nvidia` form is retained as Docker's runtime setting. It does not become an
all-device request: `NVIDIA_VISIBLE_DEVICES` continues to select devices, including `none` and `void`.
Explicit device requests follow Docker's device-selection semantics instead.

The dashboard/API importer and SDK/CLI Compose sync share one parser. Invalid counts, missing required
selectors, conflicting `count` and `device_ids`, and unsupported GPU drivers are refused before
activation. A missing count means all devices; an explicit zero stays zero. Device reservations
require `capabilities`, while the top-level `gpus` form supplies the implicit `gpu` capability.

Service create/update accepts `advanced.gpus` as one request or a list, and `advanced.runtime` as
`"nvidia"`. Omitted fields are preserved; setting either to `null` clears it. An authoritative Compose
sync also removes a setting removed from the source. Existing-container adoption captures the live
GPU configuration and retains it on the next recreate, even without a linked repository. Imported
alternative capability groups that cannot be represented faithfully remain readable during inspection,
but adoption refuses them before creating a project.

GPU detection uses Docker's reported runtime and NVIDIA CDI devices. A registered runtime alone does
not prove that a physical card is present. Preflight warns about a server with no detected GPU; Docker
still decides whether the workload can start. Changing the manual GPU mark does not close terminals
or interrupt deployment SSH connections.
