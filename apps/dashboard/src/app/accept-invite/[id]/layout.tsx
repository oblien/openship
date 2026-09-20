import type { Metadata } from "next";

// Invitation ids are bearer tokens in the URL. Keep them out of search indexes
// and Referer headers emitted by the claim document.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function AcceptInviteLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
