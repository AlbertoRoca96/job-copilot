from bs4 import BeautifulSoup
from .utils import get_text
from src.core.schema import Job

def crawl_greenhouse(slug: str):
    """
    Scrape a Greenhouse board:
    - Picks up openings across common layouts
    - Follows each posting link to capture plain-text description (best-effort)
    """
    board_url = f"https://boards.greenhouse.io/{slug}"
    html = get_text(board_url)
    if not html:
        return []

    soup = BeautifulSoup(html, 'html.parser')
    jobs = []

    # Greenhouse commonly uses these containers/selectors for postings
    # 1) div.opening a
    # 2) section#jobs or .level-0 with a tags
    # 3) li opening links
    anchors = set()

    # Classic
    for a in soup.select('div.opening a'):
        anchors.add(a)

    # Some boards use lists/sections
    for a in soup.select('section#jobs a, ul a, li a'):
        # Heuristic: must link to /{slug}/jobs/...
        href = (a.get('href') or '')
        if slug in href and '/jobs/' in href:
            anchors.add(a)

    # Fallback: any anchor that looks like a posting link
    if not anchors:
        for a in soup.find_all('a', href=True):
            href = a['href']
            if slug in href and '/jobs/' in href:
                anchors.add(a)

    for a in anchors:
        title = a.get_text(strip=True)
        href = a.get('href', '')
        if not title or not href:
            continue

        full = href if href.startswith('http') else f"https://boards.greenhouse.io{href}"

        # Try to find a nearby location element in classic layout
        location = ''
        parent = a.find_parent(['div', 'li'])
        if parent:
            loc_el = parent.select_one('.location, .pr-2, .opening .location')
            if loc_el:
                location = loc_el.get_text(strip=True)

        # Pull description from the job page (best-effort)
        desc_text = ''
        job_html = get_text(full)
        if job_html:
            jsoup = BeautifulSoup(job_html, 'html.parser')
            # Main description container used by GH
            main = jsoup.select_one('.content, .opening, .job, .application, #content')
            if not main:
                main = jsoup
            # Strip scripts/style and extract text
            for tag in main(['script', 'style']):
                tag.decompose()
            desc_text = ' '.join(main.get_text(separator=' ', strip=True).split())

        jobs.append(Job(
            title=title,
            company=slug,
            location=location,
            url=full,
            description=desc_text,
            source='greenhouse'
        ).to_dict())

    # De-dup on (title, url)
    uniq = {}
    for j in jobs:
        uniq[(j['title'], j['url'])] = j
    return list(uniq.values())
