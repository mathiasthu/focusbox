// Minimal DOM shim for the demo/store/prefs tests. The vitest environment is
// "node" (the rest of the suite is logic-only); these tests need `window`,
// `window.location`, `window.history`, and a real `Storage`/`localStorage` so
// that `vi.spyOn(Storage.prototype, "setItem")` works. Installed by importing
// this module at the top of a test file (before the modules under test).

class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  key(i: number): string | null {
    return Array.from(this.map.keys())[i] ?? null;
  }
}

function installDomShim(): void {
  const g = globalThis as Record<string, unknown>;
  if (g.__fbDomShimInstalled) return;
  g.__fbDomShimInstalled = true;

  const storage = new MemoryStorage();

  // A mutable location whose href/pathname/search stay consistent.
  const loc = {
    href: "http://localhost/",
    pathname: "/",
    search: "",
    assign(url: string) {
      this.href = url;
    },
  };

  const win = {
    location: loc,
    localStorage: storage,
    history: {
      replaceState(_state: unknown, _title: string, url?: string) {
        if (typeof url !== "string") return;
        const u = new URL(url, "http://localhost/");
        loc.href = u.href;
        loc.pathname = u.pathname;
        loc.search = u.search;
      },
    },
  };

  g.window = win;
  g.localStorage = storage;
  // Expose Storage so `vi.spyOn(Storage.prototype, "setItem")` can hook it.
  g.Storage = MemoryStorage;
}

installDomShim();

export {};
