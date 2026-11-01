/** Compatibility entry for the singleton control-plane tunnel picker.
 * App ingress is destination-owned and implemented by platform/modules/ingress;
 * starting an in-process cloudflared agent here would expose the wrong machine.
 */
import type { TunnelProvider } from "../types";
import { ProviderNotReadyError } from "../types";
const reason="Configure Cloudflare Tunnel under your server’s Security settings. This control-plane tunnel picker does not manage app ingress.";
export const cloudflareProvider:TunnelProvider={name:"cloudflare",async preflight(){return {ok:false,reason};},async create(){throw new ProviderNotReadyError("cloudflare",reason);},async delete(){throw new ProviderNotReadyError("cloudflare",reason);},async connect(){throw new ProviderNotReadyError("cloudflare",reason);}};
