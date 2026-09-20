export {
  createShip,
  type Ship,
  type ScopedShip,
  type IdentityAdapter,
  type CreateShipOptions,
  type OwnedShip,
  type AttachedShipOptions,
  type NativeShipOptions,
  type NativePlatformOptions,
  type NativeOperator,
  type NativeCloseOptions,
} from "./native";
export { OpenshipClient, ApiError, type OpenshipClientOptions } from "./client";
export { OpenshipOperatorClient, type OpenshipOperatorClientOptions } from "./operator-client";
export { normalizeComposeServices } from "./compose";
export { iteratePages, type Page, type PageRequest, type PageIteratorOptions } from "./pagination";
export { createDeploymentHandle, waitForDeployment, consumeDeploymentEvents, type DeploymentHandle, type DeploymentOutcome, type WaitForDeploymentOptions, type DecodedDeploymentEvent, type DeploymentStreamResult } from "./deployment-handle";
export type { DeploySourceInput, SourceDeploymentResult } from "./source-input";
export type * from "@repo/contracts";
export {
  AppError,
  OperationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
} from "@repo/contracts";
