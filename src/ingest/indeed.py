# src/ingest/indeed.py
from bs4 import BeautifulSoup
from urllib.parse import urlencode, quote_plus, urljoin
from datetime import datetime, timezone
import time, requests

from src.core.schema import Job
from src.core.scoring import tokens_from_terms

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)

def _build_search_urls(profile: dict) -> list[str]:
    titles = list(tokens_from_terms(profile.get("target_titles") or [])) or []
    raw_titles = [t for t in (profile.get("target_titles") or []) if isinstance(t, str)]
    if raw_titles:
        titles.extend(raw_titles)
    titles = sorted({t for t in titles if t})

    locs = [l for l in (profile.get("locations") or []) if isinstance(l, str) and l.strip()]
    if not locs:
        locs = [""]  # nationwide / remote is common in UI; empty gives wide results

    days = 0
    sp = (profile.get("search_policy") or {})
    try:
        days = max(0, int(sp.get("recency_days") or 0))
    except Exception:
        days = 0

    urls = []
    for title in (titles or [""]):
        for loc in locs:
            params = {
                "q": title,
                "l": loc,
                "sort": "date",          # newest first
            }
            if days > 0:
                params["fromage"] = str(days)  # age in days
            urls.append(f"https://www.indeed.com/jobs?{urlencode(params)}")
    return urls

def _fetch(url: str) -> str | None:
    try:
        r = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=20)
        if r.status_code != 200:
            return None
        return r.text
    except Exception:
        return None

def crawl_indeed(profile: dict) -> list[dict]:
    out = []
    for url in _build_search_urls(profile):
        html = _fetch(url)
        if not html:
            continue

        soup = BeautifulSoup(html, "html.parser")

        # Modern Indeed list items often have:
        # <a class="tapItem" href="/rc/clk?jk=..." >
        #   <h2 class="jobTitle">...</h2>
        #   <span class="companyName">...</span>
        #   <div class="companyLocation">...</div>
        #   <div class="job-snippet">...</div>
        #   <span class="date">...</span>
        # </a>
        for a in soup.select("a.tapItem"):
            try:
                href = a.get("href")
                if not href:
                    continue
                full_url = href if href.startswith("http") else urljoin("https://www.indeed.com", href)

                title_el = a.select_one("h2.jobTitle")
                title = (title_el.get_text(" ", strip=True) if title_el else "").strip()

                comp_el = a.select_one(".companyName")
                company = comp_el.get_text(" ", strip=True) if comp_el else ""

                loc_el = a.select_one(".companyLocation")
                location = loc_el.get_text(" ", strip=True) if loc_el else ""

                snip_el = a.select_one(".job-snippet")
                snippet = snip_el.get_text(" ", strip=True) if snip_el else ""

                date_el = a.select_one("span.date")
                posted_iso = None
                if date_el:
                    # "Just posted", "3 days ago", etc. -> keep raw text
                    txt = date_el.get_text(" ", strip=True)
                    posted_iso = None  # leave None; relative text is too fuzzy for ISO

                out.append(
                    Job(
                        title=title,
                        company=company,
                        location=location,
                        url=full_url,
                        description=snippet,
                        source="indeed",
                    ).to_dict()
                )
            except Exception:
                continue

        time.sleep(0.8)

    return out
