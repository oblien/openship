import { Type, type Static } from "@sinclair/typebox";

const RegistryHost = Type.String({ minLength: 1, maxLength: 255 });
const RepositoryPrefix = Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 255 }), Type.Null()]));
const Username = Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 255 }), Type.Null()]));
const Credentials = Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 16_384 }), Type.Null()]));

export const CreateContainerRegistryBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 100 }),
  registryUrl: RegistryHost,
  repositoryPrefix: RepositoryPrefix,
  username: Username,
  credentials: Credentials,
  insecure: Type.Optional(Type.Boolean()),
});

export type TCreateContainerRegistryBody = Static<typeof CreateContainerRegistryBody>;

export const UpdateContainerRegistryBody = Type.Partial(CreateContainerRegistryBody);
export type TUpdateContainerRegistryBody = Static<typeof UpdateContainerRegistryBody>;
