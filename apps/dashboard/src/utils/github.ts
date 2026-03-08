import { githubApi } from "@/lib/api";
import { openAuthWindow } from "@/utils/authWindow";

const AUTH_API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * @deprecated Use `openAuthWindow` from `@/utils/authWindow` directly.
 */
export const initAuthWindow = async (url: string, callback: () => void, windowRef?: Window | null) => {
  // Legacy wrapper — delegates to the shared middleware.
  const handle = openAuthWindow(url);
  handle.onClose(() => {
    setTimeout(callback, 1000);
  });
};

export const handleConnectGithub = async (
  checkGithubConnection: () => void,
  showToast: (message: string, type: "success" | "error") => void,
  setLoading: (loading: boolean) => void
): Promise<void> => {
  try {
    setLoading(true);

    const handle = openAuthWindow();
    const res = await githubApi.connect();

    if (res?.mode === "desktop" && !res.needsOAuth) {
      handle.close();
      setLoading(false);
      checkGithubConnection();
      return;
    }

    if (res?.needsOAuth) {
      // Both modes: POST to Better Auth for OAuth URL
      // callbackURL must be on our own origin (Better Auth validates it)
      const callbackURL =
        res.mode === "cloud" ? "/auth/callback/install" : "/auth/callback/close";

      const oauthRes = await fetch(
        `${AUTH_API_URL}/api/auth/sign-in/social`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ provider: "github", callbackURL }),
        }
      );
      const oauthData = await oauthRes.json();
      if (oauthData?.url) {
        handle.navigate(oauthData.url);
      } else {
        handle.close();
        setLoading(false);
        showToast("Failed to start GitHub authorization", "error");
        return;
      }
    } else if (res?.url) {
      // Cloud mode, has OAuth → install URL
      handle.navigate(res.url);
    } else {
      handle.close();
      setLoading(false);
      return;
    }

    handle.onClose(() => {
      setLoading(false);
      checkGithubConnection();
    });
  } catch (error) {
    console.error("Failed to connect to GitHub:", error);
    showToast("Failed to connect to GitHub", "error");
    setLoading(false);
  }
};
