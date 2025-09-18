from .utils import get_json
from src.core.schema import Job
from datetime import datetime, timezone

def _ms_to_iso(ms) -> str | None:
    try:
        ms = int(ms)
        dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
        return dt.date().isoformat()
    except Exception:
        return None

def crawl_lever(slug: str):
    url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
    data = get_json(url) or []
    jobs = []
    for p in data:
        j = Job(
            title=p.get('text',''),
            company=slug,
            location=(p.get('categories') or {}).get('location',''),
            url=p.get('hostedUrl',''),
            description=p.get('descriptionPlain','') or '',
            source='lever'
        ).to_dict()

        # Lever has createdAt (ms since epoch)
        created = p.get('createdAt')
        iso = _ms_to_iso(created) if created is not None else None
        if iso:
            j['posted_at'] = iso

        jobs.append(j)
    return jobs
