import { Type, type Static } from "@sinclair/typebox";

export const ASSISTANT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const ASSISTANT_IMAGE_LIMIT = 4;
export const ASSISTANT_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const ASSISTANT_IMAGES_MAX_BYTES = 8 * 1024 * 1024;
export const ASSISTANT_TURN_MAX_BYTES = Math.ceil(ASSISTANT_IMAGES_MAX_BYTES / 3) * 4 + 128_000;

/** Inline images only. Never accept a host path, URL or another conversation's artifact. */
export const AssistantImageSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200, pattern: "^[^/\\\\\\x00-\\x1f]+$" }),
    mime: Type.Union(ASSISTANT_IMAGE_TYPES.map((mime) => Type.Literal(mime))),
    data: Type.String({ minLength: 16, maxLength: Math.ceil(ASSISTANT_IMAGE_MAX_BYTES / 3) * 4 }),
  },
  { additionalProperties: false },
);
export type AssistantImage = Static<typeof AssistantImageSchema>;

export function assistantImageBytes(image: Pick<AssistantImage, "data">) {
  return (
    (image.data.length * 3) / 4 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0)
  );
}

/** Shared client/server validation; MIME declarations alone are not trusted. */
export function assistantImagesError(images: AssistantImage[]): string | null {
  if (images.length > ASSISTANT_IMAGE_LIMIT) return "Attach up to 4 images per message.";
  let total = 0;
  for (const image of images) {
    if (!image.name || image.name.length > 200 || /[/\\\x00-\x1f]/.test(image.name))
      return "Choose an image with a valid filename.";
    if (!ASSISTANT_IMAGE_TYPES.includes(image.mime)) return "Use PNG, JPEG or WebP images.";
    const data = image.data;
    if (data.length > Math.ceil(ASSISTANT_IMAGE_MAX_BYTES / 3) * 4)
      return "Each image must be 4 MB or smaller.";
    if (data.length < 16 || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      return "This image could not be read. Choose it again.";
    const bytes = assistantImageBytes(image);
    if (bytes > ASSISTANT_IMAGE_MAX_BYTES) return "Each image must be 4 MB or smaller.";
    total += bytes;
    const header = atob(data.slice(0, 16));
    const valid =
      image.mime === "image/png"
        ? header.startsWith("\x89PNG\r\n\x1a\n")
        : image.mime === "image/jpeg"
          ? header.startsWith("\xff\xd8\xff")
          : header.startsWith("RIFF") && header.slice(8, 12) === "WEBP";
    if (!valid) return "The file content must match its PNG, JPEG or WebP image type.";
  }
  return total > ASSISTANT_IMAGES_MAX_BYTES ? "Keep attached images under 8 MB in total." : null;
}

/** Return only safe image bytes from native history; never expose native paths or metadata. */
export function assistantMessageImages(attachments: unknown): AssistantImage[] {
  if (!Array.isArray(attachments)) return [];
  const images: AssistantImage[] = [];
  for (const value of attachments.slice(0, ASSISTANT_IMAGE_LIMIT)) {
    if (!value || typeof value.data !== "string" || typeof value.mime !== "string") continue;
    const image = {
      name: typeof value.name === "string" && value.name ? value.name : "Attached image",
      mime: value.mime,
      data: value.data,
    } as AssistantImage;
    if (!assistantImagesError([...images, image])) images.push(image);
  }
  return images;
}
