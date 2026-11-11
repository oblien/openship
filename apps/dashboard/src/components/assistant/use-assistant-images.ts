"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ASSISTANT_IMAGE_TYPES,
  ASSISTANT_IMAGE_MAX_BYTES,
  assistantImagesError,
  type AssistantImage,
} from "@repo/contracts";

export type ComposerImage = AssistantImage & { id: string };
function readImage(file: File): Promise<AssistantImage> {
  if (!(ASSISTANT_IMAGE_TYPES as readonly string[]).includes(file.type))
    return Promise.reject(new Error("Use PNG, JPEG or WebP images."));
  if (file.size > ASSISTANT_IMAGE_MAX_BYTES)
    return Promise.reject(new Error("Each image must be 4 MB or smaller."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("This image could not be read. Choose it again."));
    reader.onload = () =>
      resolve({
        name: file.name.replace(/[/\\\x00-\x1f]/g, "_").slice(0, 200) || "Pasted image",
        mime: file.type as AssistantImage["mime"],
        data: String(reader.result).split(",")[1] ?? "",
      });
    reader.readAsDataURL(file);
  });
}

/** Local previews only; bytes travel with the authorized turn to its selected agent host. */
export function useAssistantImages() {
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const current = useRef(images),
    generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const update = useCallback((value: ComposerImage[]) => {
    current.current = value;
    setImages(value);
  }, []);
  // Restoring a failed submission uses the same validated local bytes and IDs.
  const restore = useCallback(
    (value: ComposerImage[]) => {
      generation.current++;
      update(value);
      setPending(0);
      setError(null);
    },
    [update],
  );
  // Conversation navigation depends on this stable callback.
  const clear = useCallback(() => restore([]), [restore]);
  return {
    images,
    error,
    pending: pending > 0,
    clear,
    restore,
    remove(id: string) {
      update(current.current.filter((image) => image.id !== id));
      setError(null);
    },
    async add(files: File[]) {
      if (!files.length) return;
      const revision = generation.current;
      setError(null);
      setPending((count) => count + 1);
      try {
        if (files.length + current.current.length > 4)
          throw new Error("Attach up to 4 images per message.");
        const added = await Promise.all(files.map(readImage));
        if (revision !== generation.current) return;
        const next = [
          ...current.current,
          ...added.map((image) => ({ ...image, id: crypto.randomUUID() })),
        ];
        const issue = assistantImagesError(next);
        if (issue) throw new Error(issue);
        update(next);
      } catch (error) {
        /* diagnostics-ignore: Invalid or unreadable user images are displayed inline for the current upload generation. */
        if (revision === generation.current) setError((error as Error).message);
      } finally {
        if (revision === generation.current) setPending((count) => count - 1);
      }
    },
  };
}
