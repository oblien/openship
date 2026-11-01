// Install before importing the database, auth, providers or server boot modules.
import { installNodeErrorReporting } from "@repo/core/diagnostics/node";
installNodeErrorReporting("api");
const { loadInstanceEnvironment } = await import("./lib/instance-environment");

// Integration credentials must be loaded before auth/providers are constructed.
await loadInstanceEnvironment();
const { installCloudErrorDestination } = await import("./lib/cloud-error-destination");
await installCloudErrorDestination();
await import("./server");
