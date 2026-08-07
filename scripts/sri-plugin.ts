import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

/**
 * Post-build: add SRI (`integrity` + `crossorigin`) to every first-party `<script src>`
 * and `<link rel="stylesheet" href>` in dist/index.html.
 *
 * What this does NOT cover, stated plainly because the previous version claimed the
 * property silently and delivered it for 2 of 14 emitted assets:
 *
 *  - **Dynamically imported chunks.** They are fetched by the module loader, not by a tag
 *    in the HTML, and HTML has no way to express integrity for them. Not fixable here.
 *  - **`sw.js` / `workbox-*.js`.** Fetched by `serviceWorker.register()` and
 *    `importScripts()`, where SRI does not apply at all. This is the highest-value target
 *    of the set, and it is uncovered.
 *
 * And the ceiling on what SRI buys in this deployment: every one of these assets is
 * same-origin under `script-src 'self'`, and an attacker who can swap `/assets/*.js` on
 * the VPS can equally rewrite index.html to drop the integrity attributes. It is a
 * tripwire against a partial write, not a defense against a compromised origin.
 *
 * What changed: a tag whose asset cannot be hashed now FAILS the build instead of being
 * skipped silently, and the coverage numbers are printed so "SRI is on" can be checked
 * rather than assumed.
 */
export function sri(): Plugin {
  return {
    name: "focusbox-sri",
    apply: "build",
    async closeBundle() {
      const dist = resolve(process.cwd(), "dist");
      const indexPath = resolve(dist, "index.html");
      let html: string;
      try {
        html = await readFile(indexPath, "utf8");
      } catch {
        return; // no index emitted (e.g. tauri-only build path)
      }

      const unhashable: string[] = [];
      let covered = 0;

      async function hashOf(assetPath: string): Promise<string | null> {
        // Only hash same-origin, root-relative assets we actually emitted. A remote or
        // relative src is not ours to vouch for — left alone, and not counted as a miss.
        if (!assetPath.startsWith("/")) return null;
        try {
          const buf = await readFile(resolve(dist, assetPath.replace(/^\//, "")));
          return "sha384-" + createHash("sha384").update(buf).digest("base64");
        } catch {
          // Root-relative, so it should have been emitted into dist — a miss here means
          // the tag points at something that isn't there.
          unhashable.push(assetPath);
          return null;
        }
      }

      // <script type=module src="/assets/x.js">
      const scriptRe = /<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>/g;
      // <link rel="stylesheet" ... href="/assets/x.css">
      const linkRe = /<link\b([^>]*?)\brel="stylesheet"([^>]*?)\bhref="([^"]+)"([^>]*)>/g;

      let out = html;

      out = await replaceAsync(out, scriptRe, async (m, pre, src, post) => {
        if (/integrity=/.test(m)) return m;
        const h = await hashOf(src);
        if (!h) return m;
        covered++;
        return `<script${pre}src="${src}"${post} integrity="${h}" crossorigin="anonymous"></script>`;
      });

      out = await replaceAsync(out, linkRe, async (m, pre, mid, href, post) => {
        if (/integrity=/.test(m)) return m;
        const h = await hashOf(href);
        if (!h) return m;
        covered++;
        return `<link${pre}rel="stylesheet"${mid}href="${href}"${post} integrity="${h}" crossorigin="anonymous">`;
      });

      if (unhashable.length > 0) {
        throw new Error(
          `SRI: could not hash ${unhashable.length} first-party asset(s) referenced by ` +
            `index.html: ${unhashable.join(", ")}. Refusing to emit an index.html that ` +
            `claims integrity for some tags and silently omits it for others.`,
        );
      }

      const emitted = await countEmittedAssets(dist);
      console.log(
        `SRI: ${covered} of ${emitted} emitted js/css assets carry integrity ` +
          `(the rest are dynamically-imported chunks and the service worker, where SRI ` +
          `cannot be expressed — see scripts/sri-plugin.ts).`,
      );

      await writeFile(indexPath, out, "utf8");
    },
  };
}

async function countEmittedAssets(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += await countEmittedAssets(p);
    else if (e.name.endsWith(".js") || e.name.endsWith(".css")) n++;
  }
  return n;
}

async function replaceAsync(
  str: string,
  re: RegExp,
  fn: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches: { match: string; args: string[]; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    matches.push({ match: m[0], args: m.slice(0, m.length) as string[], index: m.index });
  }
  let result = "";
  let last = 0;
  for (const { match, args, index } of matches) {
    result += str.slice(last, index);
    result += await fn(...args);
    last = index + match.length;
  }
  result += str.slice(last);
  return result;
}
