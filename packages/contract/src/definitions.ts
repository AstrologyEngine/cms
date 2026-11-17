/** Wire types for `GET /v1/definitions`: every collection and key, no text. */
import type { Shape } from "./shapes.js";

export type KeyStatus = "active" | "unused" | "deleted";
export type KeyDefinition = { placeholders: string[]; status: KeyStatus };
export type CollectionDefinition = {
  shape: Shape;
  keys: Record<string, KeyDefinition>;
};
export type Definitions = {
  /** The CMS default locale; a manifest must be written in it. */
  default: string;
  version: number;
  collections: Record<string, CollectionDefinition>;
};
