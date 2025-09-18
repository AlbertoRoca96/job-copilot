from bs4 import BeautifulSoup
from .utils import get_text
from src.core.schema import Job

def crawl_greenhouse(slug: str):
    url = f"https://boards.greenhouse.io/{slug}"
    html = get_text(url)
    soup = BeautifulSoup(html, 'html.parser')
    jobs = []
    for post in soup.select('.opening a'):
        title = post.get_text(strip=True)
        href = post.get('href', '')
        full = href if href.startswith('http') else f"https://boards.greenhouse.io{href}"
        loc_el = post.find_parent('div', class_='opening').select_one('.location')
        location = loc_el.get_text(strip=True) if loc_el else ''
        jobs.append(Job(
            title=title, company=slug, location=location,
            url=full, description='', source='greenhouse'
        ).to_dict())
    return jobs
