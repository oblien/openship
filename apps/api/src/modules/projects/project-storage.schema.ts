import { Type } from "@sinclair/typebox";
import { OBJECT_STORAGE_PROVIDERS } from "@repo/core";
import type { TLiteral } from "@sinclair/typebox";

/**
 * Request body for POST /:id/storage. Two shapes share one object: either
 * `sourceProjectId` (an installed MinIO app in this org) or an explicit
 * provider + endpoint + credentials. The service rejects the ambiguous and
 * incomplete combinations with a message the UI can show, rather than a schema
 * union that would report "does not match any of the allowed types".
 */
export const BindObjectStorageBody = Type.Object({
  bucket: Type.String({ minLength: 1, maxLength: 255, description: "Bucket the app reads/writes." }),
  sourceProjectId: Type.Optional(
    Type.String({ minLength: 1, description: "Installed MinIO app to take the endpoint + keys from." }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("internal"), Type.Literal("public")], {
      description:
        "Reachability for a source app: internal = the shared private network, public = its published endpoint.",
    }),
  ),
  provider: Type.Optional(
    Type.Union(
      OBJECT_STORAGE_PROVIDERS.map((p) => Type.Literal(p)) as [TLiteral<string>, ...TLiteral<string>[]],
      { description: "External provider. Omit when using sourceProjectId." },
    ),
  ),
  endpoint: Type.Optional(
    Type.String({ maxLength: 2000, description: "S3 API endpoint URL. Derived for AWS." }),
  ),
  region: Type.Optional(Type.String({ maxLength: 64 })),
  accessKeyId: Type.Optional(Type.String({ maxLength: 500 })),
  secretAccessKey: Type.Optional(Type.String({ maxLength: 500 })),
});
