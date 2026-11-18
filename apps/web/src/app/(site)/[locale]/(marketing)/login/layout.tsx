import type { Metadata } from "next";
import type { ReactNode } from "react";
import { shareImageFor } from "@/lib/share-cards";

const title = "Sign in";
const description = "Sign in to your OpenShip account.";
const images = shareImageFor("/login");

export const metadata: Metadata = {
  title,
  description,
  robots: { index: false, follow: false, nocache: true },
  alternates: { canonical: "https://app.openship.io/login" },
  openGraph: { title, description, images, type: "website", siteName: "OpenShip" },
  twitter: { card: "summary_large_image", title, description, images },
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
