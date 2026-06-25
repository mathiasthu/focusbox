import { SYNC_API_URL } from "./config";
import type { KdfParams } from "./crypto";

export interface SignupBody {
  email: string;
  auth_hash: string;
  wrapped_adk: string;
  recovery_wrapped_adk: string;
  recovery_auth_hash: string;
  kdf_params: KdfParams;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface LoginResult extends Tokens {
  wrapped_adk: string;
  recovery_wrapped_adk: string;
  kdf_params: KdfParams;
}

export interface RecoverStartResult {
  recovery_wrapped_adk: string;
  kdf_params: KdfParams;
}

export interface RecoverCompleteBody {
  email: string;
  recovery_auth_hash: string;
  new_auth_hash: string;
  new_wrapped_adk: string;
  kdf_params: KdfParams;
}

export interface ManifestEntry {
  key: string;
  version: number;
  updated_at: string;
}

export interface BlobData {
  key: string;
  ciphertext: string;
  nonce: string;
  version: number;
  updated_at: string;
}

export interface PushBody {
  key: string;
  ciphertext: string;
  nonce: string;
  base_version?: number;
  device_id?: string | null;
}

export interface PushResult {
  key: string;
  version: number;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "unauthorized") {
    super(401, message);
    this.name = "UnauthorizedError";
  }
}

export class ConflictError extends ApiError {
  currentVersion: number;
  constructor(currentVersion: number) {
    super(409, "version_conflict");
    this.name = "ConflictError";
    this.currentVersion = currentVersion;
  }
}

/** Thrown when a write is rejected because the subscription is inactive (402). */
export class PaymentRequiredError extends ApiError {
  constructor(message = "sync_inactive") {
    super(402, message);
    this.name = "PaymentRequiredError";
  }
}

export interface AccountInfo {
  email: string;
  billing_enabled: boolean;
  sync_enabled: boolean;
  subscription_status: string;
  current_period_end: string | null;
}

export type Plan = "monthly" | "annual";

export interface BillingApi {
  getAccount(token: string): Promise<AccountInfo>;
  createCheckout(token: string, plan: Plan): Promise<{ url: string }>;
  createPortal(token: string): Promise<{ url: string }>;
  deleteAccount(token: string): Promise<void>;
}

/** The blob-sync surface the orchestrator depends on (injectable for tests). */
export interface SyncApi {
  getManifest(token: string): Promise<ManifestEntry[]>;
  getBlob(token: string, key: string): Promise<BlobData>;
  pushBlob(token: string, body: PushBody): Promise<PushResult>;
  deleteBlob(token: string, key: string): Promise<void>;
}

export interface AuthApi {
  signup(email: string, body: Omit<SignupBody, "email">): Promise<Tokens>;
  login(email: string, authHash: string): Promise<LoginResult>;
  refresh(refreshToken: string): Promise<{ access_token: string }>;
  recoverStart(email: string, recoveryAuthHash: string): Promise<RecoverStartResult>;
  recoverComplete(body: RecoverCompleteBody): Promise<Tokens>;
}

/** A fetch-compatible function. In the Tauri app we inject `@tauri-apps/plugin-http`'s
 * fetch (Rust-side, no CORS); in the browser/tests the global `fetch` is used. */
export type FetchImpl = typeof fetch;

async function request(
  baseUrl: string,
  path: string,
  fetchImpl: FetchImpl,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const resp = await fetchImpl(`${baseUrl}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (resp.status === 401 || resp.status === 403) throw new UnauthorizedError();
  if (resp.status === 402) throw new PaymentRequiredError();
  if (resp.status === 409) {
    let current = 0;
    try {
      const data = await resp.json();
      current = data?.detail?.current_version ?? 0;
    } catch {
      /* ignore parse error */
    }
    throw new ConflictError(current);
  }
  if (!resp.ok) throw new ApiError(resp.status, `request failed: ${resp.status}`);
  return resp;
}

export function createHttpApi(
  baseUrl: string = SYNC_API_URL,
  fetchImpl: FetchImpl = fetch,
): SyncApi & AuthApi & BillingApi {
  return {
    async signup(email, body) {
      const r = await request(baseUrl, "/v1/auth/signup", fetchImpl, {
        method: "POST",
        body: { email, ...body },
      });
      return r.json();
    },
    async login(email, authHash) {
      const r = await request(baseUrl, "/v1/auth/login", fetchImpl, {
        method: "POST",
        body: { email, auth_hash: authHash },
      });
      return r.json();
    },
    async refresh(refreshToken) {
      const r = await request(baseUrl, "/v1/auth/refresh", fetchImpl, {
        method: "POST",
        body: { refresh_token: refreshToken },
      });
      return r.json();
    },
    async recoverStart(email, recoveryAuthHash) {
      const r = await request(baseUrl, "/v1/auth/recover/start", fetchImpl, {
        method: "POST",
        body: { email, recovery_auth_hash: recoveryAuthHash },
      });
      return r.json();
    },
    async recoverComplete(body) {
      const r = await request(baseUrl, "/v1/auth/recover/complete", fetchImpl, {
        method: "POST",
        body,
      });
      return r.json();
    },
    async getManifest(token) {
      const r = await request(baseUrl, "/v1/sync", fetchImpl, { token });
      return (await r.json()).blobs;
    },
    async getBlob(token, key) {
      const r = await request(baseUrl, `/v1/sync/${encodeURIComponent(key)}`, fetchImpl, { token });
      return r.json();
    },
    async pushBlob(token, body) {
      const r = await request(baseUrl, "/v1/sync", fetchImpl, { method: "POST", token, body });
      return r.json();
    },
    async deleteBlob(token, key) {
      await request(baseUrl, `/v1/sync/${encodeURIComponent(key)}`, fetchImpl, {
        method: "DELETE",
        token,
      });
    },
    async getAccount(token) {
      const r = await request(baseUrl, "/v1/account/me", fetchImpl, { token });
      return r.json();
    },
    async createCheckout(token, plan) {
      const r = await request(baseUrl, "/v1/billing/checkout", fetchImpl, {
        method: "POST",
        token,
        body: { plan },
      });
      return r.json();
    },
    async createPortal(token) {
      const r = await request(baseUrl, "/v1/billing/portal", fetchImpl, { method: "POST", token });
      return r.json();
    },
    async deleteAccount(token) {
      await request(baseUrl, "/v1/account", fetchImpl, { method: "DELETE", token });
    },
  };
}
