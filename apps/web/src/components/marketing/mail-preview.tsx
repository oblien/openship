import Image from "next/image";
import { useLocale } from "next-intl";
import { useCopy } from "@/i18n/use-copy";
import styles from "./mail-preview.module.css";

/** The mail client leads; the localized administration panel sits behind it. */
export function MailPreview({
  priority = false,
  sizes = "(max-width: 980px) 85vw, 46vw",
}: {
  priority?: boolean;
  sizes?: string;
}) {
  const locale = useLocale();
  const copy = useCopy();

  return (
    <figure className={styles.preview}>
      <div className={styles.canvas}>
        <div className={styles.stack}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className={styles.admin}
            src={`/screenshots/${locale}/mail-control-panel.webp`}
            alt={copy("OpenShip Mail control panel showing mailbox accounts, quotas, and administration tabs.")}
            width={2400}
            height={1520}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
          />
          <Image
            className={styles.client}
            src="/email-preview.png"
            alt={copy("Mail client showing an inbox and an open conversation.")}
            width={6000}
            height={4267}
            sizes={sizes}
            loading={priority ? "eager" : "lazy"}
            fetchPriority={priority ? "high" : undefined}
          />
        </div>
      </div>
      <figcaption>
        <span>{copy("Mail client & control panel")}</span>
        <span>{copy("Your domains. Your accounts. One place.")}</span>
      </figcaption>
    </figure>
  );
}
