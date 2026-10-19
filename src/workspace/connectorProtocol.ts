// Consented local restart mechanism for the connector, web-app side.
//
// A normal website cannot launch local programs silently. The only supported
// bridge is a per-user URL protocol handler that the ONE-TIME SETUP registers
// on Windows (HKCU\Software\Classes\nexuss — no admin, visible, removable).
// The registered command is a FIXED absolute path captured at setup time; the
// URL carries no parameters into the shell, so a web page can only ever ask
// "start the connector", never "run this command".
//
// Navigating to the scheme makes Windows ask for confirmation the first time
// ("Open Nexuss Terminal?"); the user can remember the choice. If no handler
// is registered the request is a silent no-op — the caller must treat that as
// "restart unavailable" and fall back to the setup flow, never as success.

/** Fixed action URL — no query string, no user-controlled data. */
export const CONNECTOR_START_URL = "nexuss://start-connector";

/** sessionStorage marker: the most recent healthy install reported protocol >= 2. */
const PROTOCOL_SEEN_KEY = "nexuss.connector.protocolSeen";

/** Minimum protocol that ships with the nexuss:// launcher registered. */
const PROTOCOL_WITH_LAUNCHER = 2;

/**
 * Remember that a healthy connector with the local launcher (protocol >= 2)
 * was seen in this tab session. The restart path is only attempted when we
 * have real evidence the launcher exists — older installs cannot be started
 * from a page and must go through the setup flow instead.
 */
export function rememberConnectorProtocol(protocol: number | undefined): void {
  if (typeof window === "undefined") return;
  try {
    if (protocol !== undefined && protocol >= PROTOCOL_WITH_LAUNCHER) {
      window.sessionStorage.setItem(PROTOCOL_SEEN_KEY, "1");
    }
  } catch {
    // Storage unavailable — restart simply won't be offered this session.
  }
}

/** True when a current-generation install (with launcher) was seen this session. */
export function hasConnectorLauncher(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(PROTOCOL_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

/** Test/reset hook — clears the session launcher marker. */
export function clearConnectorLauncherMemory(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PROTOCOL_SEEN_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Ask Windows to start the installed connector via the registered protocol
 * handler. Fire-and-forget by design: the OS may show a one-time confirmation
 * dialog, and there is no callback channel back to the page. The caller must
 * verify success the only honest way — by polling the health endpoint.
 *
 * Returns false when the environment cannot issue the request at all (SSR /
 * missing DOM); the request itself is still best-effort in a browser.
 */
export function requestConnectorStart(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") return false;
  try {
    const iframe = document.createElement("iframe");
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");
    iframe.src = CONNECTOR_START_URL;
    document.body.appendChild(iframe);
    // Long-lived on purpose: if the OS confirmation dialog is shown, the
    // navigation must stay pending until the user answers. Remove eventually
    // so the DOM never accumulates launch frames.
    window.setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        // Already detached.
      }
    }, 120000);
    return true;
  } catch {
    return false;
  }
}
