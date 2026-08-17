/**
 * Oblien tunnel provider — Cloud-only. Operator never connects to Oblien.
 */

import type {
  TunnelProvider,
  TunnelProvisionInput,
} from "../types";
import { ProvisionFailedError } from "../types";

export const oblienProvider: TunnelProvider = {
  name: "oblien",

  async preflight() {
    return {
      ok: false,
      reason: "Oblien tunnels are not available on Operator.",
    };
  },

  async create(_input: TunnelProvisionInput) {
    throw new ProvisionFailedError(
      "oblien",
      "Oblien tunnels are not available on Operator.",
    );
  },

  async delete() {
    return;
  },

  async connect() {
    throw new ProvisionFailedError(
      "oblien",
      "Oblien tunnels are not available on Operator.",
    );
  },
};
