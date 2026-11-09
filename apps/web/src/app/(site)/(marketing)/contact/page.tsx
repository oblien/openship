import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import Link from "next/link";
import { ContactPage as ContactPageLayout } from "@/components/marketing/contact-page";
import { SUPPORT_EMAIL } from "@repo/core";

const PAGE_TITLE = "Contact Us";
const PAGE_DESCRIPTION =
  "Get in touch with the Openship team. Send us a message and we'll get back to you as soon as possible.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/contact" },
  openGraph: {
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
    url: "/contact",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} - Openship`,
    description: PAGE_DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return inheritSocialImages(metadata, parent);
}

export default function ContactPage() {
  return (
    <ContactPageLayout
      source="contact"
      eyebrow="Contact"
      title={
        <>
          Let’s talk.
          <br />
          <span>We’re here to help.</span>
        </>
      }
      description="Questions about Openship, your next project, or working together? Send a message to the team. We’ll reply by email."
      links={[
        {
          illustration: "mail",
          title: "Reach the team",
          description: SUPPORT_EMAIL,
          href: `mailto:${SUPPORT_EMAIL}`,
        },
        {
          illustration: "logs-monitoring",
          title: "Need product support?",
          description: "Get help with your deployments, Cloud account, or billing.",
          href: "/support",
        },
        {
          illustration: "configuration-as-code",
          title: "Report a bug or share an idea",
          description: "Follow development and contribute on GitHub.",
          href: "https://github.com/oblien/openship/issues",
        },
      ]}
    >
      <div className="marketing-contact-notes">
        <p>For sensitive reports, contact the right team directly.</p>
        <div>
          <a href="mailto:security@oblien.com">Security</a>
          <a href="mailto:privacy@openship.io">Privacy</a>
          <a href="mailto:legal@openship.io">Legal</a>
          <Link href="/trust">Trust &amp; security</Link>
        </div>
      </div>
    </ContactPageLayout>
  );
}
