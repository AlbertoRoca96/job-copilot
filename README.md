# job-copilot (Web-Only)

This repo:

* crawls boards (Greenhouse/Lever) via **GitHub Actions**,
* ranks roles against your profile & **location policy** in `src/core/profile.yaml`,
* drafts tailored **cover letters** and **edits your real DOCX resume in-place** (format preserved),
* saves artifacts to `docs/` and publishes a **read-only dashboard** via **GitHub Pages** (no server/CLI).

## Use it (web only)

1. **Resume** – put your base file at `assets/Resume-2025.docx`.
2. **Profile** – edit `src/core/profile.yaml` (contact, skills, target\_titles, `location_policy.remote_only: true` or allowed states).
3. **Portfolio** – (optional but recommended) add truthful bullets in `src/core/portfolio.yaml` so tailoring has real material.
4. **Targets** – edit `targets.yaml` (companies + include/exclude keywords).
5. **Run** → Actions → **crawl-and-rank** (scrape + score).
6. **Tailor** → Actions → **draft-covers** (writes covers, tailored DOCX, and change logs).
7. **View** – open your Pages site (Settings → Pages). Each job card links to **JD**, **Cover**, **Resume (DOCX)**, and **Explain** (before/after + why).

### Optional: LLM-assist (for smarter, non-repetitive clauses)

* Add repo secrets: `OPENAI_API_KEY`, then set env `USE_LLM=1` (workflow or repo env).
* Model defaults to `gpt-4o-mini` (override with `OPENAI_MODEL`).
* The system enforces “no fabrication,” uses live JD text, and keeps a banlist to avoid repeated phrases.

## What gets produced

* `docs/outbox/*.md` — cover drafts
* `docs/resumes/<company>_<title>_<jdhash>.docx` — tailored resumes (filename + DOCX metadata include JD hash; dashboard links add `?v=<hash>` to bust cache)
* `docs/changes/*.json` — “Explain” change logs (before/after + reasons)
* `docs/changes/*.jd.txt` — exact JD text used
* `docs/data/scores.json` — dashboard feed
* `docs/data/banlist.json` — anti-duplication list for clauses

## Notes & guardrails

* Tailoring is **surgical**: appends short, JD-aligned clauses to existing bullets and can reorder skills; it never inflates years or invents work.
* Deterministic rules in `src/tailor/policies.yaml` run even without an API key; LLM suggestions merge in at runtime when enabled.

## Ethics & ToS

* Respect robots.txt and site ToS.
* Prefer public endpoints (e.g., Greenhouse/Lever JSON/HTML).
* Keep a human in the loop; avoid mass applications.
* Don’t bypass captchas or login walls.

## License

MIT
