import { useTranslations } from "next-intl";
import { createCopy } from "./copy";

/** Shared presentation components work in both server and client rendering. */
export function useCopy() {
  return createCopy(useTranslations("Copy"));
}
