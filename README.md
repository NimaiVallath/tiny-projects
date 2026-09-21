# Tiny Projects

> Small software, finished with intent.

![Quality checks](https://github.com/NimaiVallath/tiny-projects/actions/workflows/quality.yml/badge.svg)
![MIT licensed](https://img.shields.io/badge/license-MIT-efe9df)

This is a growing collection of compact experiments in creative coding,
developer tools, data, interaction design, and applied algorithms. Each project
must earn its place: it needs a clear idea, a working artifact, thoughtful
documentation, and a repeatable quality check.

![Commit Canvas example](projects/001-commit-canvas/examples/portfolio.svg)

## The collection

| # | Project | What it explores | Built with |
|---:|---|---|---|
| 001 | [Commit Canvas](projects/001-commit-canvas) | Deterministic art generated from language | Python, SVG, hashing |
| 002 | [Time Loom](projects/002-time-loom) | A full-day clock that makes build time and activity rhythms visible | JavaScript, SVG, data visualization |
| 003 | [Latency Lantern](projects/003-latency-lantern) | Robust, route-aware diagnostics for request logs | JavaScript, HTML, robust statistics |
| 004 | [Contrast Compass](projects/004-contrast-compass) | Accessible palette pairings with minimal, hue-preserving repairs | Python, HTML, accessibility |

## The quality bar

- **A memorable hook.** Every project should be explainable in one sentence.
- **A real artifact.** No empty scaffolds, tutorial clones, or contribution-graph filler.
- **Visible craft.** Include a demo, screenshot, sample output, or transcript.
- **Engineering evidence.** Add focused tests and document the interesting decisions.
- **Honest authorship.** AI assistance is acknowledged; project selection, direction,
  review, and final quality remain human-owned.

## Run the checks

```bash
python3 scripts/check.py
```

The repository is intentionally low-dependency so that every experiment is easy
to inspect and run. Individual projects may choose a larger stack when the idea
genuinely benefits from it.

## About the process

Projects are developed incrementally with an AI-assisted workflow. Automation
can propose and implement a small experiment, but it may only commit work that
passes the repository checks and the standards in [`AGENTS.md`](AGENTS.md).
The commit history is the record of real work over time; commits are never empty
or backdated.

— [NimaiVallath](https://github.com/NimaiVallath)
