import {
  isCmsError,
  fetchDefinitions,
  fetchSyncState,
  syncManifest,
} from "@astrologyengine/cms-contract/sync";
import { describe, expect, it } from "vitest";

type Call = { url: string; method: string; headers: Headers; body: unknown };

/** A fetch that records requests and answers with the given responses in order. */
const stub = (...responses: (Response | Error)[]) => {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const origin = "https://cms.example.test/";
const token = "t".repeat(40);
const definitions = { default: "en", version: 3, collections: {} };
const result = {
  commit: "a".repeat(40),
  changed: true,
  version: 4,
  createdCollections: [],
  created: ["ui:x"],
  reactivated: [],
  unused: [],
  refreshed: [],
  drift: [],
};

describe("fetchDefinitions", () => {
  it("GETs the public definitions without credentials", async () => {
    const { fetch, calls } = stub(json(definitions));
    expect(await fetchDefinitions({ origin, fetch })).toEqual(definitions);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://cms.example.test/v1/definitions");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.headers.has("authorization")).toBe(false);
  });
});

describe("fetchSyncState", () => {
  it("GETs the admin sync state with the token", async () => {
    const state = { head: null, recent: [] };
    const { fetch, calls } = stub(json(state));
    expect(await fetchSyncState({ origin, token, fetch })).toEqual(state);
    expect(calls[0]!.url).toBe("https://cms.example.test/v1/admin/sync");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
  });
});

describe("syncManifest", () => {
  const request = {
    commit: "a".repeat(40),
    expected: null,
    manifest: { locale: "en", collections: {} },
  };

  it("POSTs the manifest with token and actor and returns the summary", async () => {
    const { fetch, calls } = stub(json(result));
    expect(
      await syncManifest({ origin, token, fetch, actor: "web-ci", ...request }),
    ).toEqual(result);
    expect(calls[0]).toMatchObject({
      url: "https://cms.example.test/v1/admin/sync",
      method: "POST",
      body: request,
    });
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(calls[0]!.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(calls[0]!.headers.get("x-cms-actor")).toBe("web-ci");
  });

  it("omits the actor header unless given", async () => {
    const { fetch, calls } = stub(json(result));
    await syncManifest({ origin, token, fetch, ...request });
    expect(calls[0]!.headers.has("x-cms-actor")).toBe(false);
  });

  it.each([
    [
      409,
      {
        code: "definition_conflict",
        message: "Conflicts.",
        conflicts: [{ code: "key_retired", collection: "ui", key: "x" }],
      },
    ],
    [412, { code: "precondition_failed", message: "Another sync." }],
    [401, { code: "unauthorized", message: "Token." }],
  ])(
    "throws CmsError for %i with the CMS code and details",
    async (status, error) => {
      const { fetch } = stub(json({ error }, status));
      const thrown = await syncManifest({
        origin,
        token,
        fetch,
        ...request,
      }).catch((caught: unknown) => caught);
      expect(thrown).toBeInstanceOf(Error);
      expect(isCmsError(thrown)).toBe(true);
      const { code, message, ...details } = error;
      expect(thrown).toMatchObject({ status, code, message, details });
    },
  );

  it("reports non-JSON error bodies and network failures", async () => {
    const html = stub(new Response("<h1>Bad gateway</h1>", { status: 502 }));
    await expect(
      syncManifest({ origin, token, fetch: html.fetch, ...request }),
    ).rejects.toMatchObject({ status: 502, code: "http_error" });
    const down = stub(new TypeError("fetch failed"));
    await expect(
      fetchDefinitions({ origin, fetch: down.fetch }),
    ).rejects.toMatchObject({
      status: 0,
      code: "network_error",
      message: expect.stringContaining("fetch failed"),
    });
  });
});
