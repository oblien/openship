import type { Metadata } from "next";
import type { ReactNode } from "react";

const TITLE = "Desktop Mail Setup";
const DESCRIPTION =
  "Set up your Openship mailbox in Thunderbird, Outlook, Spark, or K-9. Standard IMAP/SMTP fields that match almost every desktop client.";
const PATH = "/mail/setup-guide/desktop";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  openGraph: {
    title: `${TITLE} - Openship`,
    description: DESCRIPTION,
    url: PATH,
    type: "article",
    siteName: "Openship",
    locale: "en_US",
  },
  twitter: { card: "summary_large_image", title: `${TITLE} - Openship`, description: DESCRIPTION },
};

export default function Layout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
