import { cache } from "react";
import { getTranslations } from "next-intl/server";
import { createCopy } from "./copy";

export const getCopy = cache(async () => createCopy(await getTranslations("Copy")));
