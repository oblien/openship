import { UnsupportedVcsStrategy } from "./unsupported.strategy";

export class SelfHostedStrategy extends UnsupportedVcsStrategy {
  protected readonly provider = "self-hosted";
}
