import { describe, expect, it } from "vitest";
import { isSafeLinkUrl } from "../components/Notes";

describe("note link URL policy", () => {
  it("allows ordinary web and mail links", () => {
    expect(isSafeLinkUrl("https://example.com/x")).toBe(true);
    expect(isSafeLinkUrl("http://example.com/x")).toBe(true);
    expect(isSafeLinkUrl("mailto:someone@example.com")).toBe(true);
    expect(isSafeLinkUrl("example.com/x")).toBe(true); // bare host: gets defaultProtocol
  });

  it("rejects protocol-relative URLs", () => {
    // No scheme of its own, so it inherits the page's. TipTap's stock isAllowedUri lets
    // these through, and on Windows the app is served over http://tauri.localhost, so
    // //evil.example resolves to plain HTTP against a remote host.
    expect(isSafeLinkUrl("//evil.example/x")).toBe(false);
    expect(isSafeLinkUrl("  //evil.example/x")).toBe(false);
  });

  it("rejects script and data schemes", () => {
    expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("JavaScript:alert(1)")).toBe(false);
    expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeLinkUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isSafeLinkUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeLinkUrl("tauri://localhost/")).toBe(false);
  });
});
