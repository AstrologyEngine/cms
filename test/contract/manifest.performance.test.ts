import type {
  EntryOf,
  ParamsOf,
  TextKeys,
} from "@astrologyengine/cms-contract/manifest";
import type { NamedFields } from "@astrologyengine/cms-contract/shapes";
import { describe, expectTypeOf, it } from "vitest";
import { largeManifest } from "./fixtures/large-manifest";

type L = typeof largeManifest;

type Key = TextKeys<L, "ui">;
/** Every key's param names; resolving this forces all 1,000 ParamsOf types. */
type ParamNames = { [K in Key]: keyof ParamsOf<L, "ui", K> }[Key];

describe("manifest types at scale (1,000 text keys)", () => {
  it("resolves keys and params", () => {
    expectTypeOf<Key>().toBeString();
    expectTypeOf<ParamNames>().toEqualTypeOf<"p0" | "p1" | "p2">();
    expectTypeOf<EntryOf<L, "body", "B99">>().toEqualTypeOf<NamedFields>();
  });
});
