import { useCopy } from "@/i18n/use-copy";
import { useLocale } from "next-intl";
import {
  DEPLOY_SCREEN_SIZE,
  WALKTHROUGH_SCREEN_SIZE,
  localizedScreenshot,
} from "@/lib/marketing-screenshots";

/**
 * Hero showcase - center dashboard screenshot flanked by two
 * companion shots tilted behind it. Sits directly under the hero.
 */
export function Dashboard() {
  const copy = useCopy();
  const locale = useLocale();

  return (
    <section className="dashboard-showcase">
      <div className="site-container">
        <div className="dashboard-stack">
          {/* eslint-disable @next/next/no-img-element */}
          <div className="dashboard-stack__back dashboard-stack__back--left" aria-hidden="true">
            <img
              src={localizedScreenshot("/walkthrough/operate.jpg", locale)}
              {...WALKTHROUGH_SCREEN_SIZE}
              alt=""
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="dashboard-stack__back dashboard-stack__back--right" aria-hidden="true">
            <img
              src={localizedScreenshot("/walkthrough/build.jpg", locale)}
              {...WALKTHROUGH_SCREEN_SIZE}
              alt=""
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="dashboard-stack__center">
            <img
              src={localizedScreenshot("/screen.png", locale)}
              alt={copy("OpenShip dashboard")}
              loading="lazy"
              decoding="async"
              {...DEPLOY_SCREEN_SIZE}
            />
          </div>
          {/* eslint-enable @next/next/no-img-element */}
        </div>
      </div>
    </section>
  );
}
