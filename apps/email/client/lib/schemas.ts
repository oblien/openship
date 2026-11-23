import { z } from 'zod';

export const serializedFileSchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number(),
  lastModified: z.number(),
  base64: z.string(),
});

export const serializeFiles = async (files: File[]) => {
  return await Promise.all(
    files.map(async (file) => {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onerror = reject;
        reader.onload = () => {
          const base64String = reader.result as string;
          resolve(base64String.split(',')[1]!); // Remove the data URL prefix
        };
        reader.readAsDataURL(file);
      });

      return {
        name: file.name,
        type: file.type,
        size: file.size,
        lastModified: file.lastModified,
        base64,
      };
    }),
  );
};

export const deserializeFiles = (serializedFiles: z.infer<typeof serializedFileSchema>[]) => {
  return serializedFiles.map((data) => {
    const file = Uint8Array.from(atob(data.base64), (char) => char.charCodeAt(0));
    const blob = new Blob([file], { type: data.type });
    const newFile = new File([blob], data.name, {
      type: data.type,
      lastModified: data.lastModified,
    });
    return newFile;
  });
};

export const createDraftData = z.object({
  to: z.string(),
  cc: z.string().optional(),
  bcc: z.string().optional(),
  subject: z.string(),
  message: z.string(),
  attachments: z.array(serializedFileSchema).optional(),
  id: z.string().nullable(),
});

export type CreateDraftData = z.infer<typeof createDraftData>;
