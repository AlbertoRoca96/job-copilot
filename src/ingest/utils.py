# src/ingest/utils.py
import json
import random
import time
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Reusable session with retries/backoff
_session: Optional[requests.Session] = None

def _get_session() -> requests.Session:
    global _session
    if _session is not None:
        return _session
    s = requests.Session()
    retries = Retry(
        total=4,                # up to 4 retry attempts
        backoff_factor=0.6,     # 0.6s, 1.2s, 2.4s, 4.8s…
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "HEAD"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retries, pool_connections=20, pool_maxsize=20)
    s.mount("http://", adapter)
    s.mount("https://", adapter)
    s.headers.update({
        "User-Agent": "job-copilot/1.0 (+https://github.com/AlbertoRoca96/job-copilot)",
        "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
    })
    _session = s
    return s

def _sleep_jitter(min_ms=120, max_ms=380):
    # polite delay to avoid getting rate limited
    time.sleep(random.uniform(min_ms/1000.0, max_ms/1000.0))

def get_text(url: str, timeout: float = 15.0) -> str:
    """Fetch URL and return text; return '' on failure."""
    try:
        s = _get_session()
        resp = s.get(url, timeout=timeout)
        if resp.status_code >= 400:
            return ""
        _sleep_jitter()
        return resp.text or ""
    except Exception:
        return ""

def get_json(url: str, timeout: float = 15.0) -> Any:
    """Fetch URL and parse JSON; return None on failure."""
    try:
        s = _get_session()
        resp = s.get(url, timeout=timeout)
        if resp.status_code >= 400:
            return None
        _sleep_jitter()
        try:
            return resp.json()
        except json.JSONDecodeError:
            return None
    except Exception:
        return None
