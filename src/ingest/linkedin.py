# src/ingest/linkedin.py
from bs4 import BeautifulSoup
from datetime import datetime, timedelta, timezone
from urllib.parse import quote_plus
import time, requests

from .utils import get_text          # you already use this pattern; if it enforces UA/timeouts, great
from src.core.schema import Job
from src.core.scoring import tokens_from_terms

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

def _secs_from_days(days: int) -> int:
    try:
        d = max(0, int(days or 0))
        return d * 24 * 60 * 60
    except Exception:
        return 0

def _build_search_urls(profile: dict) -> list[str]:
    titles = list(tokens_from_terms(profile.get("target_titles") or [])) or []
    # if user gave phrase-y titles, also include the raw phrases:
    raw_titles = [t for t in (profile.get("target_titles") or []) if isinstance(t, str)]
    if raw_titles:
        titles.extend(raw_titles)
    titles = sorted({t for t in titles if t})

    locs = [l for l in (profile.get("locations") or []) if isinstance(l, str) and l.strip()]
    if not locs:
        locs = [""]  # LinkedIn can search “Anywhere” if location omitted

    recency_sec = _secs_from_days(((profile.get("search_policy") or {}).get("recency_days") or 0))
    f_tpr = f"&f_TPR=r{recency_sec}" if recency_sec > 0 else ""

    urls = []
    base = "https://www.linkedin.com/jobs/search/?"
    for title in (titles or [""]):
        kw = f"keywords={quote_plus(title)}"
        for loc in locs:
            locq = f"&location={quote_plus(loc)}" if loc else ""
            urls.append(f"{base}{kw}{locq}{f_tpr}")
    return urls

def _fetch(url: str) -> str | None:
    # use requests directly (get_text may be fine too—keep consistent with your repo)
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
        if r.status_code != 200:
            return None
        return r.text
    except Exception:
        return None

def crawl_linkedin(profile: dict) -> list[dict]:
    """Return a list[Job.to_dict()] from public LinkedIn job search pages."""
    out = []
    for url in _build_search_urls(profile):
        html = _fetch(url)
        if not html:
            continue

        soup = BeautifulSoup(html, "html.parser")

        # Cards often look like:
        # <a class="base-card__full-link" href="..." >TITLE</a>
        # <h4 class="base-search-card__subtitle">COMPANY</h4>
        # <span class="job-search-card__location">LOCATION</span>
        # <time datetime="2025-09-23">...</time>
        for card in soup.select("div.base-search-card, li.base-card"):
            try:
                a = card.select_one("a.base-card__full-link, a.job-card-container__link")
                if not a or not a.get("href"):
                    continue
                url = a.get("href").split("?")[0].strip()

                title = (a.get_text(strip=True) or "").strip()

                comp_el = card.select_one(".base-search-card__subtitle, .job-card-container__company-name")
                company = comp_el.get_text(strip=True) if comp_el else ""

                loc_el = card.select_one(".job-search-card__location")
                location = loc_el.get_text(strip=True) if loc_el else ""

                time_el = card.find("time")
                posted_iso = None
                if time_el and time_el.get("datetime"):
                    try:
                        dt = datetime.fromisoformat(time_el["datetime"].replace("Z", "+00:00"))
                        posted_iso = dt.date().isoformat()
                    except Exception:
                        posted_iso = None

                # Description snippet is not reliably present on the list page;
                # grab the summary line if available.
                desc_el = card.select_one(".job-search-card__snippet, .result-benefits__text")
                snippet = (desc_el.get_text(" ", strip=True) if desc_el else "").strip()

                out.append(
                    Job(
                        title=title,
                        company=company,
                        location=location,
                        url=url,
                        description=snippet,
                        source="linkedin",
                    ).to_dict()
                    | ({ "posted_at": posted_iso } if posted_iso else {})
                )
            except Exception:
                continue

        # light politeness delay
        time.sleep(0.8)

    return out
