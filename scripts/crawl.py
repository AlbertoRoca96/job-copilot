# scripts/crawl.py
import os, sys, json, traceback, argparse, hashlib, time
from typing import List, Dict, Set

# Make src importable
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

# Providers
from src.ingest.greenhouse import crawl_greenhouse
from src.ingest.lever import crawl_lever
from src.ingest.linkedin import crawl_linkedin
from src.ingest.indeed import crawl_indeed

# Scoring/token helpers (for profile-driven filters)
from src.core.scoring import tokens_from_terms, tokenize

import requests
from datetime import datetime, timezone

ROOT = os.path.dirname(__file__)
DATA_DIR = os.path.join(ROOT, '..', 'data')
OUT_JSONL = os.path.join(DATA_DIR, 'jobs.jsonl')

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SRK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def _sha1(s: str) -> str:
    import hashlib
    return hashlib.sha1((s or "").strip().lower().encode("utf-8")).hexdigest()

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _dedup_on_url(items: List[Dict]) -> List[Dict]:
    seen = set(); out = []
    for j in items:
        u = (j.get('url') or '').strip().lower()
        if not u or u in seen: continue
        seen.add(u); out.append(j)
    return out

def _get_profile(user_id: str) -> dict:
    url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}&select=*"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    arr = r.json()
    return (arr[0] if arr else {}) or {}

def _get_boards() -> List[Dict]:
    # include enabled boards with source+slug, leave room for future registries
    url = f"{SUPABASE_URL}/rest/v1/boards?enabled=eq.true&select=source,slug"
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
    r.raise_for_status()
    return r.json() or []

def _update_board_status(source: str, slug: str, status: str, error: str | None = None):
    url = f"{SUPABASE_URL}/rest/v1/boards?source=eq.{source}&slug=eq.{slug}"
    payload = {"status": status, "error": error or None, "last_crawled_at": _now_iso()}
    requests.patch(
        url,
        headers={
            "apikey": SRK, "Authorization": f"Bearer {SRK}",
            "Content-Type": "application/json", "Prefer": "return=minimal"
        },
        data=json.dumps(payload),
        timeout=20,
    )

# ---------- Profile-driven filtering ----------
def _build_filters(profile: dict):
    """
    inc/exc: use skills + titles inclusions, with a strict TITLE gate so we can
    safely crawl general-purpose job boards (LinkedIn/Indeed) without relying on
    hand-curated exclusion lists.
    """
    title_tokens = tokens_from_terms(profile.get('target_titles'))

    # lightweight synonyms to not miss obvious variants
    if "editor" in title_tokens:    title_tokens.add("editorial")
    if "editorial" in title_tokens: title_tokens.add("editor")
    if "writer" in title_tokens:    title_tokens.add("writer")

    skill_tokens = tokens_from_terms(profile.get('skills'))
    inc = title_tokens | skill_tokens

    # sensible default exclusions (still helpful)
    exc = {"senior","staff","principal","lead","manager","director"}

    return title_tokens, inc, exc

def _keep_factory(title_tokens: Set[str], inc: Set[str], exc: Set[str]):
    """
    Keep a job if:
      (1) Title contains ANY target-title token (strict gate),
      (2) title+desc contains ANY include token,
      (3) and NONE of the exclude tokens.
    """
    def _keep(j: Dict) -> bool:
        title = str(j.get('title') or '').lower()
        desc  = str(j.get('description') or '').lower()
        blob  = f"{title} {desc}"

        if title_tokens and not (title_tokens & tokenize(title)):
            return False
        if inc and not any(k in blob for k in inc):
            return False
        if exc and any(k in blob for k in exc):
            return False
        return True
    return _keep

def _upsert_jobs(user_id: str, jobs: List[Dict]):
    """
    Bulk upsert into public.jobs with on_conflict(user_id,url_hash).
    """
    if not jobs:
        return
    # shape rows
    rows = []
    for j in jobs:
        rows.append({
            "user_id": user_id,
            "source": j.get("source",""),
            "source_slug": j.get("company") if j.get("source") in ("greenhouse","lever") else (j.get("source_slug") or None),
            "url": j.get("url",""),
            "url_hash": _sha1(j.get("url","")),
            "title": j.get("title",""),
            "company": j.get("company"),
            "location": j.get("location"),
            "description": j.get("description"),
            "posted_at": j.get("posted_at"),
            "meta": j.get("extras") or {},
        })
    # chunk to keep payload reasonable
    url = f"{SUPABASE_URL}/rest/v1/jobs?on_conflict=user_id,url_hash"
    headers = {
        "apikey": SRK, "Authorization": f"Bearer {SRK}",
        "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates"
    }
    CHUNK = 500
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i:i+CHUNK]
        r = requests.post(url, headers=headers, data=json.dumps(chunk), timeout=60)
        r.raise_for_status()

def main(user_id: str):
    os.makedirs(DATA_DIR, exist_ok=True)

    profile = _get_profile(user_id)
    title_tokens, inc, exc = _build_filters(profile)
    keep = _keep_factory(title_tokens, inc, exc)

    print("Title gate tokens:", sorted(list(title_tokens)))
    print("Include tokens (sample 30):", sorted(list(inc))[:30], "…")
    print("Exclude tokens:", sorted(list(exc)))

    boards = _get_boards()
    if not boards:
        print("No boards in Supabase table 'boards'."); return

    all_jobs: List[Dict] = []
    failures = 0
    for b in boards:
        src = (b.get('source') or '').strip().lower()
        slug = (b.get('slug') or '').strip().lower()
        if not src or not slug: continue

        print(f'-- Crawling {src}:{slug} --')
        try:
            if src == 'greenhouse':
                jobs = crawl_greenhouse(slug)
            elif src == 'lever':
                jobs = crawl_lever(slug)
            elif src == 'linkedin':
                jobs = crawl_linkedin(profile)   # slug ignored; we build from profile
            elif src == 'indeed':
                jobs = crawl_indeed(profile)     # slug ignored; we build from profile
            else:
                print(f'  !! Unknown source {src} (skipping)'); 
                _update_board_status(src, slug, "skipped", f"unknown source {src}")
                continue

            kept = [j for j in jobs if keep(j)]
            kept = _dedup_on_url(kept)
            print(f'  found={len(jobs)} kept={len(kept)}')

            # persist
            try:
                _upsert_jobs(user_id, kept)
                _update_board_status(src, slug, "ok", None)
            except Exception as e:
                failures += 1
                _update_board_status(src, slug, "error", f"persist: {e}")
                print(f'  !! Persist failed for {src}:{slug}: {e}')

            all_jobs.extend(kept)
        except Exception as e:
            failures += 1
            _update_board_status(src, slug, "error", f"crawl: {e.__class__.__name__}: {e}")
            print(f'  !! Failed {src}:{slug}: {e.__class__.__name__}: {e}')
            traceback.print_exc(limit=1)

    # keep legacy artifact for downstream ranker and dev visibility
    with open(OUT_JSONL, 'w') as f:
        for j in all_jobs:
            f.write(json.dumps(j) + '\n')

    print(f"Crawled {len(all_jobs)} jobs across {len(boards)} boards (failures: {failures}) -> {OUT_JSONL}")

if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--user', required=True)
    args = ap.parse_args()
    main(args.user)
