# Project Context

@AGENTS.md

# Fork-Specific Notes (ksdisch/pi)

This is Kyle's fork of `earendil-works/pi`. Everything imported above is upstream's AGENTS.md; the rules below are fork-only. Don't edit AGENTS.md for fork conventions — put them here.

- **Git targets:** branches and PRs go to `origin` (ksdisch/pi) `main`, never to `upstream` (earendil-works/pi).
- **Git workflow:** the global autonomous branch → PR → adversarial-review → merge workflow stands for fork work. AGENTS.md's "never commit unless the user asks" governs upstream contributions, not this fork's own branches.
- **Fork additions live in `.pi/`:** playtest harness (`.pi/playtest/`), intercom session messaging (`.pi/intercom/`), handoffs, prompts, skills, extensions. Upstream's code-quality rules still apply to any TypeScript there.
- **Why this file exists:** pi itself loads AGENTS.md natively (it precedes CLAUDE.md in pi's per-directory candidate list, `packages/coding-agent/src/core/resource-loader.ts`), so pi sessions ignore this file. It exists so Claude Code sessions get the same project rules via the import above.
