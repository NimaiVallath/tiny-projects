# Portfolio Project Guidelines

## Mission

Grow this repository into a memorable portfolio of small, complete software
projects. Optimize for originality, clarity, and evidence of engineering
judgment—not commit frequency.

## What a project must demonstrate

Every new project must include all of the following:

1. A one-sentence hook that is meaningfully different from existing projects.
2. A working artifact that can be run locally without paid services or secrets.
3. A project README containing the idea, usage, design decisions, and limitations.
4. At least one focused automated test or deterministic validation.
5. A visible demo artifact such as an SVG, screenshot, sample output, or transcript.
6. An entry in `projects/catalog.json` and the root project table.

Prefer a small idea executed exceptionally well over a broad, unfinished app.

## Creative rotation

Vary the kind of thinking on display. Rotate among creative coding, data
visualization, developer tools, accessible interfaces, applied algorithms,
automation, and playful utilities. Do not repeat the same primary language or
project category more than twice in succession.

Avoid tutorial clones, generic CRUD apps, trivial wrappers around an API, fake
businesses, and projects whose only purpose is producing a commit.

## Workflow for each run

1. Read the root README, this file, and `projects/catalog.json`.
2. Inspect the recent Git history so the next idea adds variety.
3. Choose one project that can be completed and verified in the current run.
4. Assign the next three-digit project number and a concise kebab-case slug.
5. Implement the smallest polished version, including docs, demo, and tests.
6. Run `python3 scripts/check.py` and any project-specific checks.
7. Review the complete diff for secrets, generated clutter, and weak explanations.
8. Update the catalog and root README only after the project is complete.
9. Create one descriptive commit such as `feat(project-002): add <name>`.
10. Push only after all checks pass.

If a strong project cannot be completed, improve an existing project in a
substantive way or leave the repository unchanged and explain why. Never create
an empty, cosmetic-only, or backdated commit.

## Git and safety rules

- Pull with fast-forward only before starting.
- Never force-push, rewrite history, delete branches, or modify existing tags.
- Do not commit credentials, personal data, `.env` files, build caches, or vendored
  dependencies.
- Do not add network services, paid APIs, analytics, or telemetry without explicit
  approval.
- Keep automated changes inside this repository.
- Stop without committing when tests fail or the remote branch has diverged.

## Voice

Write like a thoughtful builder: concise, specific, and curious. Explain why a
design choice matters. Avoid hype, inflated metrics, and claims that cannot be
demonstrated by the code.
