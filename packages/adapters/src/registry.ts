import type { DeploymentAdapter } from "./base-adapter";
import { DockerAdapter } from "./docker-adapter";
import { OblienAdapter } from "./oblien-adapter";

/**
 * Adapter registry — resolves the correct adapter based on config.
 *
 * Self-hosted → DockerAdapter
 * Cloud mode  → OblienAdapter
 */
export function getAdapter(mode: "docker" | "oblien" = "docker"): DeploymentAdapter {
  switch (mode) {
    case "oblien":
      return new OblienAdapter(
        process.env.OBLIEN_API_URL || "https://api.oblien.com",
        process.env.OBLIEN_API_KEY || "",
      );
    case "docker":
    default:
      return new DockerAdapter();
  }
}
