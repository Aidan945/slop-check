# 🍝 slop-check

### How vibe-coded is your codebase?

**slop-check** grades any repo's slop level, hands you a fun report card, and gives you
copy-paste prompts to fix what's wrong. It's a skill for AI coding agents — run one command,
get a verdict in chat, and open a self-contained report card at a local URL.

> The roast is the headline. The receipts are the product.

It's a game on the surface — a tier ranking from **Senior Engineer** down to **GPT-3.5,
Unsupervised** — and a real code review underneath, where every point of slop cites an
actual `file:line` and comes with a prompt to fix it.

<!-- Replace with a screenshot of examples/demo-report.html -->
<!-- ![A slop-check report card](examples/screenshot.png) -->

### 👉 [**See a live demo report card →**](https://aidan945.github.io/slop-check/)

It's a single self-contained HTML file — no server, no build, works offline. The source
lives in [`examples/demo-report.html`](examples/demo-report.html).

---

## The tiers

Your **Slop Percentage** — how much of the codebase reads as slop — drops you on a six-rung
ladder. Lower is better. You climb toward the right.

| Slop % | Tier | |
|---|---|---|
| 0–10% | **Senior Engineer** | A real, competent human clearly cared about this. |
| 11–25% | **Mid-Level Engineer** | Genuinely fine. Also, slightly mid. |
| 26–45% | **Advanced Vibe Coder** | AI-assisted, but you know what good looks like. |
| 46–65% | **Somehow, It Works** | It runs. Don't ask how. |
| 66–85% | **Zoned-Out Vibe Coder** | You were on your phone for at least three of these files. |
| 86–100% | **GPT-3.5, Unsupervised** | Nobody read anything. Ever. |

*(There's a rumored 🏆 **Cracked 10x Engineer** badge for sub-3% slop. It has to be earned.)*

---

## What you get

Run it and you get a verdict in chat right away:

```
🍝 Slop Check: 58% slop — "Somehow, It Works"
Scanned: 312 files · 41,980 lines · 2 cycles · 9.4% duplication · 84 AI tells
Worst offenders:
  • src/context/CartContext.tsx — 1,612-line god object imported by 47 components
  • src/services/checkout.ts:14 — circular dependency with payment.ts
  • src/components/ProductCard.tsx — ~140 lines duplicated across 5 card components
Most valuable fix: Break up CartContext — almost every coupling problem traces back to it.
Report: http://localhost:7331
```

…and a **report card** at that URL with the full breakdown: the slop dial and tier, where
you land on the scale, an itemized "receipt" of every category score, the areas of concern
with `file:line` receipts, and — the useful part — **Fix-It Prompts** you copy straight into
your coding agent.

---

## It's not just a toy

The grade is built on real engineering heuristics, not vibes about vibes:

- **It judges architecture, not style.** The deletion test (would removing this module
  actually concentrate complexity, or is it a pointless pass-through?), shallow vs. deep
  modules, layering violations, god files, circular dependencies. Heuristics adapted from
  Matt Pocock's "real engineering, not vibe coding" skills.
- **It's honest both ways.** A genuinely good codebase scores low and gets told so. A rigged
  roast would be worthless — if your code is clean, the report says it plainly.
- **No vibes-only deductions.** Every point of slop points at a real line. If it can't cite
  the line, it isn't a finding.

---

## How it works (and why it's fast)

Tools that build a full knowledge graph of your repo read *every file* with an LLM and can
take hours. slop-check is a two-pass design that finishes in minutes:

1. **A free, deterministic scan** (`scripts/slop-scan.mjs` — Node 18+, zero dependencies)
   covers **100% of the repo** with no LLM at all. In a couple of seconds it builds the
   import graph and measures the countable stuff: circular dependencies, god files, dead
   orphan files, cross-file duplication, AI-tell comments, debug leftovers, file sizes.
2. **A small judgment pass** reads only a **~12% sample** of files (the ones the scan flags
   as most worth a human read), across up to 6 parallel reviewers where the agent supports
   them, and grades what scripts can't see: shallow modules, naming, consistency. Every
   major finding is re-verified before it ships.
3. **Seven weighted categories** combine into one Slop Percentage, and the report card is
   built and served at a local URL.

The cost is roughly one code-review conversation — flat, whether the repo is 300 files or
30,000, because the sample and reviewer count are capped.

---

## The Fix-It Prompts

This is the part that makes it more than a scoreboard. Each top finding comes with a
ready-to-paste prompt for your coding agent — and it arrives **pre-loaded with context the
scan already paid for**: the target file's blast radius (who imports it), what it imports,
and a pointer to the full import map. So the agent you paste into starts warm instead of
re-exploring your repo from scratch.

> The tokens were already spent during the check — the fix prompt hands the knowledge over
> instead of making the next agent buy it again.

---

## Install

slop-check is a standard agent skill — it works with **Claude Code, Codex, Cursor, Copilot,
Gemini CLI, or any agent that supports the SKILL.md standard.** The only requirement is
**Node 18+** (used by the bundled scripts — no `npm install`, ever).

Copy or symlink this folder into your agent's skills directory. For Claude Code:

```bash
ln -s "$(pwd)/slop-check" ~/.claude/skills/slop-check
```

Then, in any repo:

```
/slop-check
```

or just ask: *"Run a slop-check on this codebase."*

---

## Good to know

- **Private and offline.** Nothing leaves your machine. The scan is local, the report is a
  local file, and the server is `localhost`-only. No telemetry, no uploads.
- **Stateless.** Each run is a fresh snapshot of the code as it is right now — it keeps no
  history and never compares against old runs (code changes too much between runs for that
  to mean anything). Re-running overwrites the previous report.
- **The report is one self-contained HTML file.** No CDN, no dependencies. It keeps working
  after the server stops, and you can share or print it.
- **It fails loud, never fake.** If a report ever fails to build, it shows an obvious error
  instead of a blank or placeholder page.

---

## Files

| | |
|---|---|
| `SKILL.md` | The process the agent follows |
| `references/HEURISTICS.md` | The smell catalog — deletion test, AI tells, naming, consistency |
| `references/SCORING.md` | Category weights, formulas, tier bands |
| `references/REPORT-SCHEMA.md` | The JSON payload the agent writes for the report |
| `src/*.mts` | The TypeScript source for the three scripts |
| `scripts/slop-scan.mjs` | Deterministic whole-repo metrics — no dependencies (compiled) |
| `scripts/build-report.mjs` | Validates the payload and injects it into the report template (compiled) |
| `scripts/serve-report.mjs` | Serves the report at a local URL — no dependencies (compiled) |
| `assets/report-template.html` | The report card (the agent never touches HTML) |
| `examples/demo-report.html` | A finished example report you can open right now |

The scripts are written in **TypeScript** (`src/*.mts`) and compiled to the `scripts/*.mjs`
files that ship in the repo, so end users run them with **zero install** — no build, no
`npm install`, just Node 18+. Contributors who want to change a script edit the `.mts`
source and run `npm install && npm run build`.

---

## Credits

Grading heuristics adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills).
The two-pass "deterministic scan + small LLM sample" approach is the lightweight cousin of
full knowledge-graph tools like [Understand-Anything](https://github.com/Lum1104/Understand-Anything).

*Grades are about the code, never the coder. Mostly.*
