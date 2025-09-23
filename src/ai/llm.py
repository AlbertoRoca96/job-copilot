import os
import json
import re
from typing import Dict, List, Any, Tuple, Optional

import requests

# -------------------- utilities --------------------

def _json_loads_safe(s: str) -> Any:
    try:
        return json.loads(s)
    except Exception:
        return None

def _trim(s: str, n: int) -> str:
    s = (s or "").strip()
    return (s[:n] + "…") if len(s) > n else s

def _collapse_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())

# -------------------- OpenAI helpers --------------------

def _openai_json(
    api_key: str,
    model: str,
    system: str,
    user: str,
    expect: str = "object",   # "object" or "array"
    max_tokens: int = 900,
    temperature: float = 0.2,
) -> Any:
    """
    Minimal JSON-structured generation using OpenAI Chat Completions.
    Returns parsed JSON (dict or list) or {} / [] on failure.
    """
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": model,
        "response_format": {"type": "json_object"} if expect == "object" else {"type": "json_schema", "json_schema": {"name":"arr","schema":{"type":"object","properties":{"items":{"type":"array"}}}}},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    try:
        r = requests.post(url, headers=headers, json=payload, timeout=60)
        r.raise_for_status()
        data = r.json()
        txt = data["choices"][0]["message"]["content"]
        obj = _json_loads_safe(txt)
        if expect == "array":
            # support either a raw list or an envelope {"policies":[...]}
            if isinstance(obj, list):
                return obj
            if isinstance(obj, dict) and isinstance(obj.get("policies"), list):
                return obj["policies"]
            return []
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return [] if expect == "array" else {}

# -------------------- public API --------------------

def suggest_policies(
    api_key: str,
    title: str,
    jd_text: str,
    allowed_vocab: List[str],
    jd_keywords: List[str],
    banned: List[str],
) -> List[Dict[str, Any]]:
    """
    Generate 5–10 concise, job-aligned clauses to append to resume bullets.
    Each item: { clause, jd_cues, bullet_cues }
    - clause: short, human + ATS friendly; no semicolons; ≤ 18 words
    - jd_cues: 3–6 key tokens from JD/keywords that justify the clause
    - bullet_cues: 2–5 tokens likely to appear in existing bullets (to gate placement)
    """
    if not api_key:
        return []  # fallback handled elsewhere

    system = (
        "You write short, concrete, job-aligned add-on phrases for resume bullets. "
        "Output an array JSON with items: {\"clause\": string, \"jd_cues\": [string], \"bullet_cues\": [string]}. "
        "Clauses must be ≤18 words, avoid buzzwords, no semicolons, start with a verb (built, designed, optimized, implemented, etc.). "
        "Prefer skills in allowed_vocab and jd_keywords; exclude anything in banlist."
    )

    user = json.dumps({
        "job_title": title,
        "job_description": _trim(jd_text, 4500),
        "allowed_vocab": allowed_vocab[:160],
        "jd_keywords": jd_keywords[:40],
        "banlist": [b.strip().lower() for b in banned if b],
        "target_count": 8
    }, ensure_ascii=False)

    arr = _openai_json(api_key, os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                       system, user, expect="array", max_tokens=900) or []

    out = []
    ban = {b.strip().lower() for b in (banned or []) if b}
    for it in arr:
        clause = _collapse_ws(str((it or {}).get("clause") or ""))
        if not clause:
            continue
        if any(tok in clause.lower() for tok in (";","  ")):
            continue
        if len(clause.split()) < 4 or len(clause.split()) > 18:
            continue
        if clause.lower() in ban:
            continue
        jd_cues = [str(x).strip().lower() for x in (it.get("jd_cues") or []) if x][:6]
        bullet_cues = [str(x).strip().lower() for x in (it.get("bullet_cues") or []) if x][:5]
        out.append({
            "clause": clause,
            "jd_cues": jd_cues,
            "bullet_cues": bullet_cues,
            "_source": "runtime"
        })
        ban.add(clause.lower())
    return out

def craft_tailored_snippets(
    api_key: str | None,
    model: str,
    job_title: str,
    jd_text: str,
    profile: Dict[str, Any],
    allowed_vocab: List[str],
    jd_keywords: List[str],
    banlist: List[str],
) -> Dict[str, Any]:
    """
    Produce structured, ATS + human readable tailoring:
      - summary_sentence: one-liner for resume summary (≤ 32 words)
      - keywords: compact keyword list (for doc props / ATS)
      - notes: brief reason (optional)
    """
    if not api_key:
        top = ", ".join(jd_keywords[:6]) if jd_keywords else ""
        sent = f"Targeted for {job_title}: hands-on with {top}."
        return {
            "summary_sentence": _collapse_ws(sent),
            "keywords": jd_keywords[:12],
            "notes": "fallback_no_llm",
        }

    system = (
        "You tailor resumes. Write one concise, human-readable, ATS-friendly "
        "sentence that would fit at the top of a resume summary for the given job. "
        "Prefer concrete skills from allowed_vocab & jd_keywords; avoid buzzword filler. "
        "Keep it under 32 words."
    )

    short_jd = _trim(jd_text, 3000)
    short_vocab = allowed_vocab[:120]
    short_kws = jd_keywords[:30]
    ban = [b.lower().strip() for b in (banlist or []) if b]

    user = json.dumps({
        "job_title": job_title,
        "job_description": short_jd,
        "allowed_vocab": short_vocab,
        "jd_keywords": short_kws,
        "banlist": ban
    }, ensure_ascii=False)

    obj = _openai_json(api_key, model, system, user, expect="object", max_tokens=600) or {}

    sentence = _collapse_ws(str(obj.get("summary_sentence") or ""))
    if not sentence:
        top = ", ".join(jd_keywords[:6]) if jd_keywords else ""
        sentence = f"Targeted for {job_title}: hands-on with {top}."
    kws = [str(k).strip() for k in (obj.get("keywords") or []) if k]
    kws = [k for k in kws if k.lower() not in ban]

    return {
        "summary_sentence": sentence,
        "keywords": (kws[:12] if kws else jd_keywords[:12]),
        "notes": obj.get("notes") or "",
    }
