import { UnsupportedVcsStrategy } from "./unsupported.strategy";

export class GitLabStrategy extends UnsupportedVcsStrategy {
  protected readonly provider = "gitlab";
}
