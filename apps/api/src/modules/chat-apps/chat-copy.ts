import type { AppLocale } from "@repo/core";
import type { ChatAppPurpose } from "@repo/contracts";
import { chatNativeCommands } from "@repo/commands";
import en from "./locales/en.json";
import ar from "./locales/ar.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import de from "./locales/de.json";
import pt from "./locales/pt.json";
import ja from "./locales/ja.json";
import zh from "./locales/zh.json";
import tr from "./locales/tr.json";
import ru from "./locales/ru.json";

export const chatDictionaries = { en, ar, es, fr, de, pt, ja, zh, tr, ru } satisfies Record<
  AppLocale,
  typeof en
>;
export function chatCopy(locale: AppLocale) {
  return chatDictionaries[locale];
}
export function formatChat(template: string, values: Record<string, string>) {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
export function localizedChatMenu(purpose: ChatAppPurpose, locale: AppLocale) {
  const copy = chatCopy(locale);
  return chatNativeCommands(purpose).map((command) => ({
    ...command,
    description: copy.commands[command.name],
  }));
}
