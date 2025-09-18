# job-copilot (Web-Only)
This repo:
- crawls boards (Greenhouse/Lever) via **GitHub Actions**,
- ranks roles for fit against `src/core/profile.yaml`,
- publishes a **read-only dashboard** via **GitHub Pages** (no server, no CLI).

## Use it (web only)
1) Upload your resume to `assets/Resume-2025.docx`.
2) Edit `src/core/profile.yaml` (skills/titles/locations).
3) Edit `targets.yaml` (which company boards to crawl).
4) Run the **crawl-and-rank** workflow in the Actions tab.
5) (Optional) Run **draft-covers** to generate cover notes.
6) Open the Pages URL (Settings → Pages) to view results.

## Ethics & ToS
- Respect robots.txt and site ToS.
- Prefer APIs/public endpoints (Greenhouse/Lever JSON).
- Keep a human in the loop; avoid mass applications.
- Don’t bypass captchas or log-in walls.

## License
MIT
