import { githubApi } from "@/lib/api";
import { openAuthWindow } from "@/utils/authWindow";

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

    const res = await githubApi.connect();

    // Already connected — just refresh
    if (res?.connected) {
      setLoading(false);
      checkGithubConnection();
      return;
    }

    switch (res?.flow) {
      case "redirect": {
        const handle = openAuthWindow();
        handle.navigate(res.url);
        handle.onClose(() => {
          setLoading(false);
          checkGithubConnection();
        });
        return;
      }

      case "device_code":
        // Device flow is handled by GitHubContext; toast for standalone callers
        showToast(`Enter code ${res.userCode} at ${res.verificationUri}`, "success");
        setLoading(false);
        return;

      case "terminal":
        showToast(res.message ?? res.command, "error");
        setLoading(false);
        return;

      default:
        setLoading(false);
    }
  } catch (error) {
    console.error("Failed to connect to GitHub:", error);
    showToast("Failed to connect to GitHub", "error");
    setLoading(false);
  }
};
