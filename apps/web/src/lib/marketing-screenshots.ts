import type { AppLocale } from "@repo/core/locale";

export const DEPLOY_SCREEN_SIZE = { width: 2998, height: 1572 } as const;
export const WALKTHROUGH_SCREEN_SIZE = { width: 1800, height: 1350 } as const;
export const WALKTHROUGH_STAGES = ["connect", "build", "ship", "route", "operate"] as const;

/** One asset path per active language; unrelated illustrations retain their source. */
export function localizedScreenshot(src: string, locale: AppLocale): string {
  if (src === "/screen.png") return `/screenshots/${locale}/deploy.webp`;
  const match = /^\/walkthrough\/([a-z-]+)\.jpg$/.exec(src);
  if (
    match &&
    WALKTHROUGH_STAGES.some((stage) => match[1] === stage || match[1] === `${stage}-light`)
  ) {
    return `/screenshots/${locale}/walkthrough/${match[1]}.webp`;
  }
  return src;
}
