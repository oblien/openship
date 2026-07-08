import type { Metadata } from "next";
import type { ReactNode } from "react";

const TITLE = "iOS & macOS Mail Setup";
const DESCRIPTION =
  "Add your Openship mailbox to Apple Mail on iPhone, iPad, or Mac. Step-by-step IMAP/SMTP setup — identical across all three devices.";
const PATH = "/mail/setup-guide/ios";

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
