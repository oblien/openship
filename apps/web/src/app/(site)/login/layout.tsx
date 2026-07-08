import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your Openship account.",
  robots: { index: false, follow: false, nocache: true },
  alternates: { canonical: "https://app.openship.io/login" },
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
