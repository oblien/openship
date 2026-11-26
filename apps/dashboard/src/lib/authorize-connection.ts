import { connectionAuthorizationLifetime, type ConnectionOAuthProvider } from "@repo/core";
import { credentialsApi } from "./api/credentials";
import { connectionResultType, openConnectionResultChannel } from "./connection-popup";
import { openAuthWindow, type AuthWindowHandle } from "@/utils/authWindow";

/** Browsers finish the grant in the popup. Desktop receives a one-time code
 * from the system browser and exchanges it under the initiating session. */
async function waitForProviderReturn(
  handle: AuthWindowHandle,
  grant: { state: string; url: string },
  signal: AbortSignal,
  expiredMessage: string,
  lifetime: number,
  onDesktopReturn: DesktopBridge["onConnectionCallback"],
): Promise<string | undefined> {
  const channel = handle.popup ? openConnectionResultChannel() : null;
  const listeners = new AbortController();
  let unsubscribe: (() => void) | undefined;
  let timer: number | undefined;
  try {
    return await new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true, signal: listeners.signal });
      timer = window.setTimeout(
        () => reject(new Error(expiredMessage)),
        lifetime * 1000,
      );
      if (handle.popup) {
        const completed = ({ data }: MessageEvent) => {
          if (data?.type !== connectionResultType || data.state !== grant.state) return;
          if (data.error) reject(new Error(String(data.error)));
          else resolve(undefined);
        };
        window.addEventListener(
          "message",
          (event) => {
            if (event.origin === window.location.origin && event.source === handle.popup)
              completed(event);
          },
          { signal: listeners.signal },
        );
        channel?.addEventListener("message", completed);
        // COOP can make a live provider popup look closed. Its callback uses the channel.
        if (!channel) handle.onClose(() => resolve(undefined));
      } else if (onDesktopReturn) {
        unsubscribe = onDesktopReturn(({ state, code }) => {
          if (state !== grant.state) return;
          if (code) resolve(code);
          else reject(new Error("Authorization was cancelled. Connect again from OpenShip."));
        });
      }
      Promise.resolve(handle.navigate(grant.url)).catch(reject);
    });
  } finally {
    listeners.abort();
    window.clearTimeout(timer);
    unsubscribe?.();
    channel?.close();
  }
}

export async function authorizeConnection(
  provider: ConnectionOAuthProvider,
  name: string,
  signal: AbortSignal,
  expiredMessage: string,
  setup?: "new",
) {
  const desktop = window.desktop?.isDesktop;
  const onDesktopReturn = window.desktop?.onConnectionCallback;
  if (desktop && !onDesktopReturn)
    throw new Error("Update OpenShip Desktop to connect through the browser, or use an API token.");
  // Reserve the browser popup synchronously under the submit gesture.
  const handle = openAuthWindow();
  if (handle.blocked) throw new Error("Allow a popup to connect this platform.");
  signal.addEventListener("abort", handle.close, { once: true });
  try {
    const grant = await credentialsApi.authorize({
      provider,
      name,
      setup,
      ...(desktop && { desktop: true }),
    });
    signal.throwIfAborted();
    if (handle.popup?.closed) throw new Error("The connection window closed. Try again.");
    const code = await waitForProviderReturn(
      handle,
      grant,
      signal,
      expiredMessage,
      connectionAuthorizationLifetime(provider),
      onDesktopReturn,
    );
    signal.throwIfAborted();
    if (code)
      return (await credentialsApi.completeAuthorization({ state: grant.state, code })).data;

    // Treat the browser notification only as a signal and read the saved grant from the API.
    const { data } = await credentialsApi.list();
    const row = data.find(
      (row) =>
        row.provider === provider &&
        row.name === name &&
        row.publicFields.authorization === "oauth",
    );
    if (!row) throw new Error("The connection window closed. Check Connections or try again.");
    return row;
  } finally {
    signal.removeEventListener("abort", handle.close);
    handle.close();
  }
}
