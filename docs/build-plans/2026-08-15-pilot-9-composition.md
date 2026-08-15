# Pilot 9 plan — the composition experiment

2026-08-15. Successor to pilot 8 (`.pi/playtest/PILOT-2026-08-14-run8.md`).

## The question

Pilot 8 answered the aim question: a taught 20px margin turns the pairing into
a landing (3 take-offs from 3 presses; run B cleared planet-1). What it did not
move is composition: **run A's seat never issued a single `jumpAtX`** — the
same behavior as pilot 7's run A, a 1-of-2 rate across two consecutive pilots
with the same prompt and the same model on both seats. The open question, named
in pilot 8 finding 5: is that fixable by prompt at all?

## Why this looks prompt-fixable: it is a retrieval failure, not a rejection

Transcript analysis of pilot 8 run A's laptop seat
(`~/.pi/agent/sessions/--Users-kyledisch-Projects-pi--/2026-08-15T01-01-51-357Z_01a002f0-817d-7013-bcae-151aa0ab47c0.jsonl`):

- 146 assistant messages over 19m17s; **311 characters of visible text in
  total**; 12 thinking blocks (3,792 characters); 78 bash calls, 42 intercom
  sends. The seat runs an act-loop with almost no deliberation.
- The word "jump" appears **zero** times in its text, zero times in its
  thinking, zero times in its tool arguments. The string `jumpAtX` occurs once
  in the whole transcript — in the prompt it was handed.
- So the seat never considered and rejected jumping; the option never surfaced.
  Its 36 deaths went to `untilX`-only walking (18 calls at 630, 3 at 650).
- Contrast run B's laptop (same prompt, same model,
  `2026-08-15T01-22-16-023Z_01a00303-3157-717a-b43b-8e2c448d2c22.jsonl`): it
  issued `jumpAtX` four times including the clear, and its thinking names aims
  ("targeting the gap at x=652").

A seat that argued itself out of jumping would need a better argument put in
front of it. A seat that never retrieved the option needs the retrieval forced
at the decision point — which a prompt can attempt.

## The change (prompt-only, `.pi/playtest/prompts/laptop.md`)

Replace the technique *suggestion* with a **trigger-bound rule** — keyed to a
reply the seat has just read, because the reply is the one input run A's loop
demonstrably attends to. Shape (final wording set at implementation; must stay
level-generic, no coordinates):

> If a death record shows you fell (its `y` is well below your standing
> height), a bare `untilX` walk cannot cross that spot — walking got you
> killed there. Your next attempt at that crossing MUST be a composed move:
> take the lip x from `lastStoodAt`, subtract at least 20, and issue that as
> `jumpAtX`, with `untilX` a little past the far side.

Riding the same prompt touch (accuracy debt in the same file, from PR #31's
review): F11 — line 57's absolute "Only a `lastStoodAt` past the gap proves
you actually got across" contradicts the corrected too-brief-touch wording
added later in the same file; soften it to the "no evidence / only positive
proof" form so the file states one rule.

## Also riding: instrumentation that wants a run to measure it

Three small harness changes, each with its own measurement channel (proposed
as one arc in today's grooming brief, `docs/backlog-hygiene/2026-08-15.md`):

1. **`recentDeaths` on `/state`** (BACKLOG item: expose more than the newest
   death). The sampler already queues; return a short newest-first list
   alongside `lastDeath`. Measure: how many sampler-only deaths reach a seat
   (pilot 8 baseline: 3 of 12).
2. **Sampler keeps `lastSeen` across the death tick** (PR #31 review F6).
   `forget()` currently nulls a sample that is a valid position of the new
   life, doubling the post-death blind window; keep it while still clearing
   `y1`/`y2`/`lastStood` (the spawn point would poison the rest test).
   Measure: neither-observer deaths (baseline 1 of 43) and sampler coverage
   (baseline 39 of 43) on comparable death volume.
3. **Handoff-digest opt-out for seats** (BACKLOG item: stop handoff-digest
   injection). `run-pilot.sh` launches seats with the handoff extension
   disabled or env-gated, ending the cross-run contamination pilots 5–7
   documented in every seat. Measure: binary — no digest turn in any seat
   startup.

## Measurements

Primary — composition per seat: did the laptop seat issue at least one
`jumpAtX` after its first fall-death record reached it? Baseline 1 of 2 seats
in two consecutive pilots; the change works if both runs' seats compose.

Secondary, unchanged protocol: take-off rate at the taught margin (baseline
3/3), the sampler table (deaths / move-observed / sampler-observed /
sampler-only / neither: 43/30/39/12/1), arm-timeouts (0 in run B), 429
survival, four seat reports.

## Honesty pre-commitments

- Several changes move at once, again. Each has a separate channel: composition
  from the move ledger, sampler window from the driver ledger, `recentDeaths`
  reach from ledger vs transcripts, digest from seat startups. The report
  states this and attributes nothing across channels.
- Armed moves stay driver-reflex; the driver still solves every puzzle.
- Every count tallies from the driver ledger (`via=` lines, kept or not) plus
  transcripts, per pilot 8's convention — `via` names whose copy was kept, not
  who saw the death.
- Note the constellation build sha; pilots 7–8 ran `604a422`.
- `PILOT_TIMEOUT_S=2100`; the freeze power id is `freeze-stars`; prompts never
  name level coordinates.

## Run-config note

Recommended: **Opus 5, effort high** — the harness edits are small and
well-specified here; the judgment lives in run supervision and the report,
which follows an established template.

`cd ~/Projects/pi && claude --model claude-opus-5 --effort high`
