# Cloud deployment resource guidance

The deployment page retains a compact cause and recovery action for resource-related
failures. **Review capacity** opens the existing Cloud space capacity and plan dialog
on demand. It makes no purchase, changes no resource limit and does not automatically
retry the deployment.

Detection uses evidence from the failing attempt:

- A failed container's existing Docker stabilization probe supplies its `OOMKilled`
  flag. The controller keeps typed evidence independently of bounded terminal logs,
  before cleanup. A different service's
  OOM cannot explain an unrelated failing operation.
- Explicit allocation errors such as `ENOMEM` are distinguished from a process's
  JavaScript heap limit. Review configured build/application limits before upgrading.
- `ENOSPC` and “no space left on device” identify failed storage allocation. The
  existing `BUILD_STORAGE_LOW` preflight measures free bytes and inodes on Docker's
  filesystem and is reported as low storage, rather than claiming the disk is full.
- Exit 137 alone proves SIGKILL, not OOM. Heap-limit and unconfirmed kill diagnoses
  point to configuration without presenting a plan upgrade as a proven solution.

The controller saves the classification and original Cloud space binding in the
existing deployment `errorDetails`, in the same write as the terminal outcome. Live
SSE, reconnect replay and the status reload retain this information, including held
partial deployments. A retry starts with a fresh diagnosis. Cancellation and unrelated
provider, network, permission and port failures retain their existing behavior.

An advisory appears after five minutes of elapsed build time while installation or
building is active. It is hidden during queueing, preparation, cloning, prompts,
cancellation and terminal states. Elapsed time is not evidence of insufficient
resources: downloads, network delays and build commands can be slow. The advisory
uses the local elapsed clock and makes no new host or billing requests. Capacity
comparison is optional.

This does not add utilization polling, capacity reservations, automatic cache/data
cleanup or new deployment enforcement. Overall Cloud space RAM/disk percentages
cannot establish the cause of one failing build, especially with concurrent apps.
