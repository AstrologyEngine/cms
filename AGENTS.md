# CMS agent instructions

Use functional programming and ESM; avoid JavaScript classes.
Use Node 24.10.0 and Bun 1.3.14. Run `bun run validate` before commits.
Internal issues live in `AstrologyEngine/web-issues`; code and PRs live here.
Run `gh` outside the sandbox. Preserve unrelated work and use isolated branches/worktrees.
Never run remote migrations, seed, or deployments as part of local tests.
The contract package is the authority for catalog, locale rules and baseline copy.
