import { cloudEmailPlanHref } from '@/lib/cloud-links';
import { getLocale } from 'next-intl/server';
import { getCopy } from '@/i18n/copy-server';
import { getCloudPricing } from '@/lib/pricing';
import { PublicMailPlans } from '../../../pricing/public-mail-plans';

export async function MailPricing() {
  const { mail } = await getCloudPricing(await getLocale());
  const copy = await getCopy();
  if (mail) return (
    <section id="mail-pricing" className="mail-wide-section" aria-labelledby="mail-pricing-title">
      <header className="mb-8 text-center">
        <h2 id="mail-pricing-title" className="mail-heading">{copy("OpenShip Mail plans")}</h2>
        <p className="mail-intro">{copy("Choose where your messages live and how much mail you send.")}</p>
      </header>
      <PublicMailPlans catalog={mail} compare />
    </section>
  );
  return (
    <section id="mail-pricing" className="mail-wide-section text-center">
      <h2 className="mail-heading">{copy("OpenShip Mail plans")}</h2>
      <p className="mail-intro">{copy("Current plans are temporarily unavailable.")}</p>
      <a href={cloudEmailPlanHref()} className="mail-primary-link mt-4">{copy("View dashboard plans")}</a>
    </section>
  );
}
