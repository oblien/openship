/** Reserve a tab inside the user's click so payment never discards a draft.
 * The API validates hosted-payment URLs; blocked popups retain a manual link. */
export function beginCheckoutNavigation(preserveProject: boolean) {
  const tab = preserveProject ? window.open("about:blank", "_blank") : null;
  if (tab) tab.opener = null;
  return {
    close: () => tab?.close(),
    navigate(value: string) {
      const url = new URL(value);
      if (url.protocol !== "https:") throw new Error("Invalid checkout URL");
      if (preserveProject) {
        if (tab && !tab.closed) tab.location.href = url.href;
      } else {
        window.location.href = url.href;
      }
      return url.href;
    },
  };
}
