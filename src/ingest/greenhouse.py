from bs4 import BeautifulSoup
from .utils import get_text
from src.core.schema import Job

import json
from datetime import datetime, timezone

def _parse_date_iso(s: str) -> str | None:
    """Return ISO date (YYYY-MM-DD) if s looks like a date; else None."""
    if not s:
        return None
    # Try full ISO with time first
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt.date().isoformat()
    except Exception:
        pass
    # Try simple YYYY-MM-DD
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date().isoformat()
    except Exception:
        return None

def _extract_posted_from_jsonld(jsoup: BeautifulSoup) -> str | None:
    # Look for JSON-LD blocks and pull "datePosted"
    for tag in jsoup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.get_text(strip=True))
        except Exception:
            continue
        # Could be an array or an object
        items = data if isinstance(data, list) else [data]
        for it in items:
            if isinstance(it, dict) and "datePosted" in it:
                iso = _parse_date_iso(str(it.get("datePosted", "")))
                if iso:
                    return iso
    return None

def _extract_posted_from_dom(jsoup: BeautifulSoup) -> str | None:
    # Common DOM hints for dates on GH pages
    # <time datetime="2025-02-01"> ... or similar meta
    time_el = jsoup.find("time")
    if time_el and time_el.get("datetime"):
        iso = _parse_date_iso(time_el.get("datetime"))
        if iso:
            return iso
    # meta/itemprop
    meta = jsoup.find(attrs={"itemprop": "datePosted"})
    if meta:
        if meta.get("content"):
            iso = _parse_date_iso(meta.get("content"))
            if iso:
                return iso
        text = meta.get_text(strip=True)
        iso = _parse_date_iso(text)
        if iso:
            return iso
    return None

def crawl_greenhouse(slug: str):
    board_url = f"https://boards.greenhouse.io/{slug}"
    html = get_text(board_url)
    if not html:
        return []

    soup = BeautifulSoup(html, 'html.parser')
    jobs = []
    anchors = set()

    # Classic layout
    for a in soup.select('div.opening a'):
        anchors.add(a)

    # Section/list-based layouts
    for a in soup.select('section#jobs a, ul a, li a'):
        href = (a.get('href') or '')
        if slug in href and '/jobs/' in href:
            anchors.add(a)

    # Fallback: anything that looks like a posting link
    if not anchors:
        for a in soup.find_all('a', href=True):
            href = a['href']
            if slug in href and '/jobs/' in href:
                anchors.add(a)

    seen = set()
    for a in anchors:
        title = a.get_text(strip=True)
        href = a.get('href', '')
        if not title or not href:
            continue
        full = href if href.startswith('http') else f"https://boards.greenhouse.io{href}"
        if full in seen:
            continue
        seen.add(full)

        # List-page location (if present)
        list_location = ''
        parent = a.find_parent(['div', 'li'])
        if parent:
            loc_el = parent.select_one('.location, .pr-2, .opening .location')
            if loc_el:
                list_location = loc_el.get_text(strip=True)

        # Pull details from job page
        page_location = ''
        desc_text = ''
        posted_iso = None

        job_html = get_text(full)
        if job_html:
            jsoup = BeautifulSoup(job_html, 'html.parser')

            # Try common location spots on GH job page
            loc_spots = jsoup.select('.location, [class*="location"], .app-location')
            for el in loc_spots:
                page_location = el.get_text(strip=True)
                if page_location:
                    break

            # Description
            main = jsoup.select_one('.content, .opening, .job, .application, #content') or jsoup
            for tag in main(['script', 'style']):
                tag.decompose()
            desc_text = ' '.join(main.get_text(separator=' ', strip=True).split())

            # Posted date (best-effort)
            posted_iso = _extract_posted_from_jsonld(jsoup) or _extract_posted_from_dom(jsoup)

        location = page_location or list_location

        j = Job(
            title=title,
            company=slug,
            location=location,
            url=full,
            description=desc_text,
            source='greenhouse'
        ).to_dict()

        if posted_iso:
            j['posted_at'] = posted_iso

        jobs.append(j)

    return jobs
