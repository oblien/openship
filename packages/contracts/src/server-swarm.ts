import { Type, type Static } from "@sinclair/typebox";

export const ConnectSwarmInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    requestId: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" }),
  },
  { additionalProperties: false },
);

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableCount = Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]);

export const SwarmInspectionInputSchema = Type.Object(
  {
    details: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const SwarmInspectionSchema = Type.Object(
  {
    state: Type.Union(
      (["inactive", "active", "pending", "locked", "error", "unknown"] as const).map((value) =>
        Type.Literal(value),
      ),
    ),
    role: Type.Union([Type.Literal("manager"), Type.Literal("worker"), Type.Null()]),
    nodeId: nullableString,
    clusterId: nullableString,
    nodeCount: nullableCount,
    managerCount: nullableCount,
    observedAt: Type.String(),
    inventory: Type.Union([
      Type.Null(),
      Type.Object(
        {
          nodes: Type.Array(
            Type.Object(
              {
                id: Type.String(),
                name: Type.String(),
                role: Type.Union([
                  Type.Literal("manager"),
                  Type.Literal("worker"),
                  Type.Literal("unknown"),
                ]),
                availability: Type.String(),
                state: Type.String(),
                leader: Type.Boolean(),
              },
              { additionalProperties: false },
            ),
          ),
          stacks: Type.Array(
            Type.Object(
              {
                name: nullableString,
                services: Type.Array(
                  Type.Object(
                    {
                      id: Type.String(),
                      name: Type.String(),
                      image: Type.String(),
                      mode: Type.Union([
                        Type.Literal("replicated"),
                        Type.Literal("global"),
                        Type.Literal("job"),
                        Type.Literal("unknown"),
                      ]),
                      desiredTasks: nullableCount,
                      runningTasks: nullableCount,
                      updateState: nullableString,
                      ports: Type.Array(
                        Type.Object(
                          {
                            published: Type.Integer(),
                            target: Type.Integer(),
                            protocol: Type.String(),
                            mode: Type.String(),
                          },
                          { additionalProperties: false },
                        ),
                      ),
                      mounts: Type.Array(
                        Type.Object(
                          { type: Type.String(), target: Type.String(), readOnly: Type.Boolean() },
                          { additionalProperties: false },
                        ),
                      ),
                    },
                    { additionalProperties: false },
                  ),
                ),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);

export type SwarmInspection = Static<typeof SwarmInspectionSchema>;
