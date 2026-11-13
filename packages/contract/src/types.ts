export type Bundle = {
  locale: string;
  default: string;
  chain: string[];
  version: number;
  entries: Record<string, Record<string, Record<string, unknown>>>;
  fallbacks: Record<string, string>;
};
export type LocaleSummary = { code: string; name: string; chain: string[] };
export type LocalesIndex = { default: string; locales: LocaleSummary[] };
