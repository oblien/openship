/**
 * Image catalog. The Oblien-hosted catalog was a Cloud-only product.
 * Operator has no Cloud image marketplace — callers get an empty list
 * and the dashboard falls back to the Custom Image tile.
 */

export interface ImageCatalogEntry {
  id?: string;
  name?: string;
  image?: string;
  logo?: string;
  description?: string;
  category?: string;
  tags?: string[];
  ports?: number[];
  defaultEnv?: Array<{ key: string; value?: string; description?: string }>;
  [key: string]: unknown;
}

export async function listImages(
  _organizationId: string,
  _params: { search?: string; category?: string } = {},
): Promise<ImageCatalogEntry[]> {
  return [];
}
