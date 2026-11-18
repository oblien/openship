import { renderOgImage, OG_SIZE } from "@/lib/og-image";

export const alt =
  "Download OpenShip - CLI, native desktop app, and self-hosted dashboard for macOS, Windows, and Linux";
export const size = OG_SIZE;
export const contentType = "image/png";

export default function OgImage() {
  return renderOgImage({
    eyebrow: "Download",
    title: "Install OpenShip. Deploy in seconds.",
    subtitle:
      "CLI, native desktop app, and self-hosted dashboard - macOS, Windows, Linux. Same backend, your choice of surface.",
    symbol: "deploy",
    accent: "#b3d8ce",
  });
}
