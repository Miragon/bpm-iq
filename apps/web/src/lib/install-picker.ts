/**
 * Open GitHub's install picker in a popup (its content is GitHub's own page —
 * repo consent can't be embedded). The overview stays in the background; when the
 * popup returns to our origin (GitHub redirect done) we close it and run
 * `onReturn` (force a registry re-sync). Popup blocked → same-tab fallback.
 */
export function openInstallPicker(installUrl: string, onReturn: () => void): void {
  const w = 1000;
  const h = 760;
  const left = window.screenX + Math.max(0, (window.outerWidth - w) / 2);
  const top = window.screenY + Math.max(0, (window.outerHeight - h) / 2);
  const popup = window.open(
    installUrl,
    "bpm-connect-repo",
    `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=yes`,
  );
  if (!popup) {
    window.location.href = installUrl;
    return;
  }
  const timer = window.setInterval(() => {
    let returnedToUs = false;
    try {
      // throws while the popup is on github.com (cross-origin); succeeds once
      // GitHub has redirected it back to our own origin
      returnedToUs = popup.location.origin === window.location.origin;
    } catch {
      /* still on GitHub */
    }
    if (returnedToUs) popup.close();
    if (popup.closed) {
      window.clearInterval(timer);
      onReturn();
    }
  }, 500);
}
