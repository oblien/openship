import { expect, test } from "bun:test";
import { collectClientMessageKeys } from "../../../scripts/web-client-messages.mjs";
import keys from "../src/i18n/client-message-keys.json";
import { clientMessages } from "../src/i18n/client-messages";
import { messageKey } from "../src/i18n/copy";
import english from "../src/i18n/messages/en.json";
import { PRODUCT_SUMMARY } from "../src/lib/product";

test("client copy covers the current client dependency graph without shipping server-only product prose", () => {
  expect(keys).toEqual(collectClientMessageKeys());
  const messages = clientMessages(english).Copy;
  for (const source of ["Features", "Monthly", "Yearly", "Search apps", "Mac, Windows and Linux"]) {
    expect(messages[messageKey(source)]).toBe(source);
  }
  expect(messages[messageKey(PRODUCT_SUMMARY)]).toBeUndefined();
  expect(Object.values(messages).every((value) => typeof value === "string")).toBe(true);
});
