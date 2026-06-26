import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Post-build: add SRI (`integrity` + `crossorigin`) to every first-party
 * <script src> and <link rel="stylesheet" href> in dist/index.html. */
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

      async function hashOf(assetPath: string): Promise<string | null> {
        // Only hash same-origin, root-relative assets we actually emitted.
        if (!assetPath.startsWith("/")) return null;
        try {
          const buf = await readFile(resolve(dist, assetPath.replace(/^\//, "")));
          return "sha384-" + createHash("sha384").update(buf).digest("base64");
        } catch {
          return null;
        }
      }

      // <script type=module src="/assets/x.js">
      const scriptRe = /<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)><\/script>/g;
      // <link rel="stylesheet" ... href="/assets/x.css">
      const linkRe = /<link\b([^>]*?)\brel="stylesheet"([^>]*?)\bhref="([^"]+)"([^>]*)>/g;

      const tasks: Promise<void>[] = [];
      let out = html;

      out = await replaceAsync(out, scriptRe, async (m, pre, src, post) => {
        if (/integrity=/.test(m)) return m;
        const h = await hashOf(src);
        if (!h) return m;
        return `<script${pre}src="${src}"${post} integrity="${h}" crossorigin="anonymous"></script>`;
      });

      out = await replaceAsync(out, linkRe, async (m, pre, mid, href, post) => {
        if (/integrity=/.test(m)) return m;
        const h = await hashOf(href);
        if (!h) return m;
        return `<link${pre}rel="stylesheet"${mid}href="${href}"${post} integrity="${h}" crossorigin="anonymous">`;
      });

      void tasks;
      await writeFile(indexPath, out, "utf8");
    },
  };
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
