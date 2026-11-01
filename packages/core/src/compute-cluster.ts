/** Server-pool membership is independent of private-network attachments. */
export interface ComputeClusterConfig {
  name: string;
  location?: string;
  networkId: string;
  serverIds: string[];
}
