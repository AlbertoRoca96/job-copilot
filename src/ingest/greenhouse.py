from bs4 import BeautifulSoup
from .utils import get_text
from src.core.schema import Job

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

        location = page_location or list_location

        jobs.append(Job(
            title=title,
            company=slug,
            location=location,
            url=full,
            description=desc_text,
            source='greenhouse'
        ).to_dict())

    return jobs
