const origin = process.argv[2];
if (!origin || !process.env.CMS_ADMIN_TOKEN)
  throw new Error("CMS origin and CMS_ADMIN_TOKEN are required");
const json = async (path, headers = {}) => {
  const response = await fetch(new URL(path, origin), {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.json();
};
if (!(await json("/health")).ok) throw new Error("CMS health failed");
await json("/v1/locales");
await json("/v1/content/en");
const coverage = await json("/v1/admin/coverage", {
  Authorization: `Bearer ${process.env.CMS_ADMIN_TOKEN}`,
});
if (!coverage.locales?.find((locale) => locale.code === "en")?.complete)
  throw new Error("English coverage is incomplete");
const unauthenticated = await fetch(new URL("/v1/admin/coverage", origin));
if (unauthenticated.status !== 401)
  throw new Error("Admin authentication failed closed check");
console.log("CMS health, public content, auth and English coverage passed");
