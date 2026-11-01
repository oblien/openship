/** Pending exclusive work; success clears the state. Error text never determines admission. */
export type OperationState<Kind extends string> =
  | { kind: Kind; status: "running" }
  | { kind: Kind; status: "failed"; error: string };

/** Project-wide destructive work; deployments and migrations keep their own run records. */
export type ProjectLifecycleOperation = OperationState<"delete">;
