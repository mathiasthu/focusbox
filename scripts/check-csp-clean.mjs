// Fails the build if the app's dist/index.html violates the crypto-origin CSP posture:
//  - no inline <script>…</script> or <style>…</style>
//  - no inline event handlers / javascript: URLs
//  - no third-party origin in any src/href (only same-origin root-relative '/...')
//  - no connect target beyond 'self' / api.focusbox.net anywhere in dist/
// Allowed first-party hosts in absolute URLs (meta OG only): app.focusbox.net.
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const DIST = resolve(process.cwd(), "dist");
const INDEX = resolve(DIST, "index.html");
const ALLOWED_HOSTS = new Set(["app.focusbox.net", "api.focusbox.net"]);
const fail = (msg) => { console.error("CSP-GATE FAIL: " + msg); process.exitCode = 1; };

const html = await readFile(INDEX, "utf8");

// 1. Inline <script> with a body (no src) — vite-plugin-pwa injects only <script src>.
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  const attrs = m[1], body = m[2].trim();
  if (!/\bsrc=/.test(attrs) && body.length > 0) fail("inline <script> body found");
}
// 2. Inline <style> blocks.
if (/<style\b[^>]*>[\s\S]*?<\/style>/.test(html)) fail("inline <style> block found");
// 3. Inline event handlers / javascript: URLs.
if (/\son[a-z]+=/i.test(html)) fail("inline on* event handler found");
if (/javascript:/i.test(html)) fail("javascript: URL found");
// 4. Third-party absolute URLs in src/href.
for (const m of html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)) {
  const host = new URL(m[1]).hostname;
  if (!ALLOWED_HOSTS.has(host)) fail("third-party src/href host: " + host);
}
// 5. Absolute URLs anywhere in og/twitter image meta must be app.focusbox.net.
for (const m of html.matchAll(/content="(https?:\/\/[^"]+)"/g)) {
  const host = new URL(m[1]).hostname;
  if (!ALLOWED_HOSTS.has(host)) fail("third-party meta content host: " + host);
}

// 6. Scan ALL dist JS for connect targets beyond self / api.focusbox.net.
async function jsFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await jsFiles(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}
for (const f of await jsFiles(DIST)) {
  const src = await readFile(f, "utf8");
  for (const m of src.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
    const host = m[1].toLowerCase();
    // Allow same-origin-less relative usage + the two app hosts + localhost dev refs in comments.
    if (host === "api.focusbox.net" || host === "app.focusbox.net") continue;
    if (host.endsWith(".stripe.com") || host === "stripe.com") continue; // billing redirect target (allow-listed)
    if (host === "localhost" || host === "127.0.0.1") continue;
    if (host.endsWith(".w3.org") || host.endsWith(".schema.org")) continue; // XML namespaces (TipTap/prosemirror)
    if (host === "react.dev") continue; // React minified error-message URLs (string literal, not a connect target)
    if (host === "prosemirror.net") continue; // ProseMirror error-message doc link (string literal, not a connect target)
    if (host === "bit.ly") continue; // workbox console.warn doc link (string literal, not a connect target)
    fail(`unexpected origin in ${f.replace(DIST + "/", "")}: ${host}`);
  }
}

if (process.exitCode === 1) {
  console.error("CSP-GATE: dist is NOT clean — fix before deploy.");
} else {
  console.log("CSP-GATE: dist/index.html + bundle are CSP-clean.");
}
