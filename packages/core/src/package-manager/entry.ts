import { bootstrapPackageManager } from "./bootstrap";

const manager = process.env.OPENSHIP_BUILD_PACKAGE_MANAGER;
if (manager !== "npm" && manager !== "pnpm" && manager !== "yarn" && manager !== "bun")
  throw new Error("Unsupported managed package manager: " + manager);
bootstrapPackageManager(manager);
