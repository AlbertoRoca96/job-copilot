from .utils import get_json
from src.core.schema import Job

def crawl_lever(slug: str):
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    data = get_json(url) or []
    jobs = []
    for p in data:
        jobs.append(Job(
            title=p.get('text',''),
            company=slug,
            location=(p.get('categories') or {}).get('location',''),
            url=p.get('hostedUrl',''),
            description=p.get('descriptionPlain','') or '',
            source='lever'
        ).to_dict())
    return jobs
