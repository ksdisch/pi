# Project Context

@AGENTS.md

# Fork-Specific Notes (ksdisch/pi)

This is Kyle's fork of `earendil-works/pi`. Everything imported above is upstream's AGENTS.md; the rules below are fork-only. Don't edit AGENTS.md for fork conventions — put them here.

- **Git targets:** branches and PRs go to `origin` (ksdisch/pi) `main`, never to `upstream` (earendil-works/pi). `gh`'s default base repo is set to `ksdisch/pi` via `gh repo set-default`, but that setting is per-clone — pass `--repo ksdisch/pi` explicitly in scripts and agent-run `gh` commands anyway; a bare `gh pr create`/`gh pr comment` in a misconfigured clone hits the public upstream repo.
- **Git workflow:** the global autonomous branch → PR → adversarial-review → merge workflow stands for fork work. AGENTS.md's "never commit unless the user asks" governs upstream contributions, not this fork's own branches.
- **Fork code:** the playtest harness (`.pi/playtest/`) and the handoff/intercom extensions (`.pi/extensions/{handoff,intercom}/`), plus rebase-sensitive patches to upstream files: `packages/ai/src/utils/retry.ts` (+ `packages/ai/test/retry.test.ts`, `packages/ai/test/fixtures/google-free-tier-429.json`), `packages/coding-agent/src/core/agent-session.ts`, `.github/workflows/{handoff,intercom}-ext.yml`, and `.gitignore`. Preserve these when rebasing onto upstream. Everything else under `.pi/` is upstream's (`.pi/prompts/`, `.pi/skills/`) or untracked runtime data (`.pi/intercom/`, `.pi/handoffs/`), not fork source.
- **Why this file exists:** pi itself loads AGENTS.md natively (it precedes CLAUDE.md in pi's per-directory candidate list, `packages/coding-agent/src/core/resource-loader.ts`), so pi sessions ignore this file. It exists so Claude Code sessions get the same project rules via the import above.
