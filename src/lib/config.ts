// Where the in-app "Support" link sends people (Stripe payment link).
// Keep this in sync with .github/FUNDING.yml and the README "Support" section.
export const SUPPORT_URL = "https://buy.stripe.com/00w7sNcd1aCY6lEazB6g80O";

// Where users reach the author for bugs / help (shown in Settings → Help & feedback).
export const SUPPORT_EMAIL = "info@momentumminds.net";

// Shown in the Settings dialog. Keep in sync with package.json / tauri.conf.json.
export const APP_VERSION = "0.2.4";

// Cloud-sync API base URL (optional paid service). Override in dev via the
// VITE_SYNC_API_URL env var; defaults to the production host.
export const SYNC_API_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_SYNC_API_URL ??
  "https://api.focusbox.net";
