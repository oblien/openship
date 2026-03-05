import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Openship — Self-Hostable Deployment Platform",
  description:
    "Deploy anywhere. Open-source deployment platform you can self-host or use our cloud.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
