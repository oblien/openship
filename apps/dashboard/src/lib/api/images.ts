import type { ComposeGpu } from "@repo/core";
import { api } from "./client";
import { endpoints } from "./endpoints";

/**
 * Image catalog entry - proxied from the Oblien `workspaces.images.list` API.
 * Field set matches the backend `ImageCatalogEntry` interface; everything is
 * optional so we can ship the proxy without locking the shape down.
 */
export interface ImageCatalogEntry {
  id?: string;
  name?: string;
  /** Docker image string, e.g. "postgres:16-alpine" */
  image?: string;
  /** Exact container argv required by this image's entrypoint. */
  commandArgv?: string[];
  supportsCloud?: boolean;
  /** Optional NVIDIA device request for this exact catalog image. */
  gpus?: ComposeGpu;
  /** URL to logo / icon */
  logo?: string;
  description?: string;
  category?: string;
  tags?: string[];
  ports?: number[];
  defaultEnv?: Array<{ key: string; value?: string; description?: string; generate?: "secret" }>;
  /** Default named-volume mounts in `volume:container/path` form. Pre-seeded
   *  into the configure step so stateful services don't lose data on restart. */
  defaultVolumes?: string[];
  [key: string]: unknown;
}

export interface ListImagesResponse {
  success: boolean;
  images: ImageCatalogEntry[];
  /** False when the local instance has no Openship Cloud connection. */
  cloudConnected?: boolean;
}

export const imagesApi = {
  /**
   * Fetch the catalog. Returns an empty `images` array when the local
   * instance isn't linked to Openship Cloud (the modal falls back to
   * the Custom Image tile in that case). Server-side caches for ~5 min.
   */
  list: (params?: { search?: string; category?: string }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.category) qs.set("category", params.category);
    const tail = qs.toString();
    const url = tail ? `${endpoints.images.list}?${tail}` : endpoints.images.list;
    return api.get<ListImagesResponse>(url);
  },
};
