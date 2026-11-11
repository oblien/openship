import type {
  AssistantNativeClient,
  MessagePage,
} from "@repo/platform/engine/modules/assistant/native-target";
import {
  ASSISTANT_IMAGES_MAX_BYTES,
  ASSISTANT_IMAGE_MAX_BYTES,
  ASSISTANT_IMAGE_LIMIT,
  assistantImageBytes,
} from "@repo/contracts";

/** Keep image history on the native host, with the same conversation boundary as its text. */
export async function assistantImageHistory(
  mindwire: AssistantNativeClient["mindwire"],
  chatId: string,
  page: MessagePage,
): Promise<MessagePage> {
  let start = page.messages.length,
    bytes = 0;
  // Native pagination budgets reference metadata. Budget the expanded image bytes too.
  while (start > 0) {
    const next = page.messages[start - 1];
    const size = (next.attachments ?? [])
      .slice(0, ASSISTANT_IMAGE_LIMIT)
      .reduce(
        (sum, image) =>
          sum +
          (image.data
            ? assistantImageBytes({ data: image.data })
            : (image.bytes ?? ASSISTANT_IMAGE_MAX_BYTES)),
        0,
      );
    if (page.messages.length - start >= 2 && bytes + size > ASSISTANT_IMAGES_MAX_BYTES) break;
    bytes += size;
    start--;
  }
  const messages = [];
  for (const message of page.messages.slice(start)) {
    const attachments = [];
    if (message.role === "user")
      for (const image of (message.attachments ?? []).slice(0, ASSISTANT_IMAGE_LIMIT)) {
        if (
          !image.data &&
          image.artifactId &&
          (image.bytes ?? Infinity) <= ASSISTANT_IMAGE_MAX_BYTES
        ) {
          const artifact = await mindwire.surfaces.artifact(image.artifactId);
          // Never resolve a filesystem path or return another chat's artifact.
          if (
            artifact.id === image.artifactId &&
            artifact.chatId === chatId &&
            artifact.bytes <= ASSISTANT_IMAGE_MAX_BYTES
          )
            attachments.push({ name: image.name, mime: artifact.mime, data: artifact.data });
        } else attachments.push(image);
      }
    messages.push({ ...message, attachments });
  }
  return {
    ...page,
    messages,
    hasMore: page.hasMore || start > 0,
    before: messages[0]?.id ?? page.before,
  };
}
