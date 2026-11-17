/**
 * HTTP client for manifest sync (docs/plans/web-owned-catalog.md §6–8).
 * Runtime-neutral (fetch only): used by the `cms-contract` CLI and usable from
 * any script or Worker.
 */
import type { Definitions } from "./definitions.js";

export type SyncRequest = {
  /** Full SHA of the web commit whose manifest is synced. */
  commit: string;
  /** The last synced commit the client checked ancestry against, or null. */
  expected: string | null;
  manifest: unknown;
};

export type SyncSummary = {
  createdCollections: string[];
  created: string[];
  reactivated: string[];
  unused: string[];
  refreshed: string[];
  /** Keys whose manifest text differs from editor-changed CMS text. */
  drift: string[];
};

export type SyncResult = SyncSummary & {
  commit: string;
  /** Whether content changed (and the content version was bumped). */
  changed: boolean;
  version: number;
};

export type SyncState = {
  head: { commit: string; syncedAt: string; actor: string } | null;
  recent: {
    id: number;
    commit: string;
    actor: string;
    createdAt: string;
    summary: SyncSummary;
  }[];
};

/** A failed CMS call: HTTP status (0 for network errors), CMS error code, details. */
export type CmsError = Error & {
  name: "CmsError";
  status: number;
  code: string;
  details: Record<string, unknown>;
};

export const cmsError = (
  status: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): CmsError =>
  Object.assign(new Error(message), {
    name: "CmsError" as const,
    status,
    code,
    details,
  });

export const isCmsError = (error: unknown): error is CmsError =>
  error instanceof Error &&
  error.name === "CmsError" &&
  "status" in error &&
  typeof error.status === "number" &&
  "code" in error &&
  typeof error.code === "string" &&
  "details" in error &&
  typeof error.details === "object" &&
  error.details !== null;

export type ClientOptions = {
  /** CMS origin, e.g. https://cms-staging.astrologyengine.dev */
  origin: string;
  fetch?: typeof fetch;
  /** Per-request timeout; default 30 s. */
  timeoutMs?: number;
};

export type AdminOptions = ClientOptions & {
  token: string;
  /** Recorded as the revision actor (X-CMS-Actor); default "sync". */
  actor?: string;
};

/** `origin` + path, tolerating a trailing slash on the origin. */
const urlOf = (origin: string, path: string) =>
  `${origin.replace(/\/+$/, "")}${path}`;

const request = async <T>(
  { origin, fetch: fetcher = fetch, timeoutMs = 30_000 }: ClientOptions,
  path: string,
  init: RequestInit = {},
): Promise<T> => {
  let response: Response;
  try {
    response = await fetcher(urlOf(origin, path), {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw cmsError(
      0,
      "network_error",
      `Could not reach ${origin}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = (body as { error?: Record<string, unknown> } | undefined)
      ?.error;
    if (error && typeof error.code === "string") {
      const { code, message, ...details } = error;
      throw cmsError(response.status, code, String(message), details);
    }
    throw cmsError(
      response.status,
      "http_error",
      `${response.status} ${response.statusText || "error"} from ${path}: ${text.slice(0, 200)}`,
    );
  }
  return body as T;
};

const adminHeaders = ({ token, actor }: AdminOptions) => ({
  authorization: `Bearer ${token}`,
  ...(actor ? { "x-cms-actor": actor } : {}),
});

/** Public definitions: every collection and key, no text. */
export const fetchDefinitions = (options: ClientOptions) =>
  request<Definitions>(options, "/v1/definitions");

/** The last synced commit and recent syncs (admin). */
export const fetchSyncState = (options: AdminOptions) =>
  request<SyncState>(options, "/v1/admin/sync", {
    headers: adminHeaders(options),
  });

/** Sync a manifest (admin). Throws CmsError on 409, 412, 422 and others. */
export const syncManifest = ({
  commit,
  expected,
  manifest,
  ...options
}: AdminOptions & SyncRequest) =>
  request<SyncResult>(options, "/v1/admin/sync", {
    method: "POST",
    headers: {
      ...adminHeaders(options),
      "content-type": "application/json",
    },
    body: JSON.stringify({ commit, expected, manifest }),
  });
