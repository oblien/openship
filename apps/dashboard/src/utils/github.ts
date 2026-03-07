import { githubApi } from "@/lib/api";

export const initAuthWindow = async (url: string, callback: () => void, windowRef?: Window | null) => {
  // Open GitHub OAuth in new window or reuse existing window
  const width = 600;
  const height = 700;
  const left = window.screen.width / 2 - width / 2;
  const top = window.screen.height / 2 - height / 2;

  let authWindow: Window | null = windowRef || null;

  if (!authWindow || authWindow.closed) {
    authWindow = window.open(
      url,
      "GitHub Authorization",
      `width=${width},height=${height},left=${left},top=${top}`
    );
  } else {
    // Reuse existing window by redirecting it
    authWindow.location.href = url;
    authWindow.focus();
  }

  // Listen for OAuth callback
  const checkWindow = setInterval(() => {
    if (authWindow?.closed) {
      clearInterval(checkWindow);
      // Refresh GitHub data after window closes
      setTimeout(() => {
        callback();
      }, 1000);
    }
  }, 500);

  return authWindow;
}

export const handleConnectGithub = async (checkGithubConnection: () => void, showToast: (message: string, type: "success" | "error") => void, setLoading: (loading: boolean) => void): Promise<void> => {
  try {
    // Get OAuth URL from backend - default to repo scope (all repos)
    setLoading(true);
    const connectionResponse = await githubApi.connect();

    if (connectionResponse?.redirectUrl) {
      initAuthWindow(connectionResponse.redirectUrl, () => {
        setLoading(false);
        checkGithubConnection();
      });
    }

  } catch (error) {
    console.error("Failed to connect to GitHub:", error);
    showToast("Failed to connect to GitHub", "error");
  }
};
