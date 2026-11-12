import { useCopy } from "@/i18n/use-copy";
import { localizedMetadata } from "@/i18n/metadata";

import type { Metadata, ResolvingMetadata } from "next";
import { inheritSocialImages } from "@/lib/social-metadata";
import { Link } from "@/i18n/Link";
import { ContactPage as ContactPageLayout } from "@/components/marketing/contact-page";

const PAGE_TITLE = "Contact Us";
const PAGE_DESCRIPTION =
  "Get in touch with the OpenShip team. Send us a message and we'll get back to you as soon as possible.";

const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  alternates: { canonical: "/contact" },
  openGraph: {
    title: `${PAGE_TITLE} - OpenShip`,
    description: PAGE_DESCRIPTION,
    url: "/contact",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `${PAGE_TITLE} - OpenShip`,
    description: PAGE_DESCRIPTION,
  },
};

export async function generateMetadata(
  _props: unknown,
  parent: ResolvingMetadata,
): Promise<Metadata> {
  return localizedMetadata(await inheritSocialImages(metadata, parent));
}

export default function ContactPage() {
  const copy = useCopy();

  return (
    <ContactPageLayout
      eyebrow="Contact"
      title={
        <>
          {copy("Let’s talk.")}
          <br />
          <span>{copy("We’re here to help.")}</span>
        </>
      }
      description={copy(
        "Questions about OpenShip, your next project, or working together? Send a message to the team. We’ll reply by email.",
      )}
      links={[
        {
          illustration: "mail",
          title: "Reach the team",
          description: "General questions, partnerships, and help accessing your account.",
          href: "#contact-name",
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
        <p>{copy("For sensitive reports, contact the right team directly.")}</p>
        <div>
          <a href="mailto:security@oblien.com">{copy("Security")}</a>
          <a href="mailto:privacy@openship.io">{copy("Privacy")}</a>
          <a href="mailto:legal@openship.io">{copy("Legal")}</a>
          <Link href="/trust">{copy("Trust & security")}</Link>
        </div>
      </div>
    </ContactPageLayout>
  );
}
