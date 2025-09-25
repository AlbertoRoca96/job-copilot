import os
import json
import re
from typing import Dict, List, Any

import requests

def _json_loads_safe(s: str) -> Any:
    try: return json.loads(s)
    except Exception: return None

def _trim(s: str, n: int) -> str:
    s = (s or "").strip()
    return (s[:n] + "…") if len(s) > n else s

def _collapse_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())

def _openai_json(api_key: str, model: str, system: str, user: str,
                 expect: str = "object", max_tokens: int = 900, temperature: float = 0.2) -> Any:
    url = "https://api.openai.com/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "response_format": {"type": "json_object"} if expect == "object"
                           else {"type": "json_schema", "json_schema": {"name": "arr", "schema": {"type": "object","properties":{"items":{"type":"array"}}}}},
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
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
            if isinstance(obj, list): return obj
            if isinstance(obj, dict) and isinstance(obj.get("policies"), list): return obj["policies"]
            return []
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return [] if expect == "array" else {}

def suggest_policies(api_key: str,
                     title: str,
                     jd_text: str,
                     allowed_vocab: List[str],
                     jd_keywords: List[str],
                     banned: List[str]) -> List[Dict[str, Any]]:
    """
    Generate concise, job-aligned clauses to append to existing bullets for ANY occupation.
    Each item: { clause, jd_cues, bullet_cues }
      - clause: ≤ 18 words, concrete, human + ATS friendly, no semicolons
      - jd_cues: 3–6 key tokens from the job description/keywords
      - bullet_cues: 2–5 tokens likely present in the source bullet (to gate placement)
    """
    if not api_key: return []

    system = (
        "You write short, concrete add-on phrases for resume bullets across ANY occupation "
        "(e.g., retail, healthcare, logistics, editorial, trades, hospitality, tech). "
        "Output JSON array items: {\"clause\": string, \"jd_cues\": [string], \"bullet_cues\": [string]}. "
        "Clauses must be ≤18 words, avoid buzzwords, no semicolons, and read naturally when appended. "
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
        if not clause: continue
        if any(tok in clause.lower() for tok in (";","  ")): continue
        if len(clause.split()) < 4 or len(clause.split()) > 18: continue
        if clause.lower() in ban: continue
        jd_cues    = [str(x).strip().lower() for x in (it.get("jd_cues") or []) if x][:6]
        bullet_map = [str(x).strip().lower() for x in (it.get("bullet_cues") or []) if x][:5]
        out.append({"clause": clause, "jd_cues": jd_cues, "bullet_cues": bullet_map, "_source": "runtime"})
        ban.add(clause.lower())
    return out

def craft_tailored_snippets(api_key: str | None, model: str, job_title: str, jd_text: str,
                            profile: Dict[str, Any], allowed_vocab: List[str],
                            jd_keywords: List[str], banlist: List[str]) -> Dict[str, Any]:
    """
    Produce an ATS-friendly, single-sentence summary for the top of a resume, for ANY job family.
    """
    if not api_key:
        top = ", ".join(jd_keywords[:6]) if jd_keywords else ""
        sent = f"Targeted for {job_title}: hands-on with {top}."
        return {"summary_sentence": _collapse_ws(sent), "keywords": jd_keywords[:12], "notes": "fallback_no_llm"}

    system = (
        "Write one concise, human-readable, ATS-friendly sentence (≤32 words) that could sit at the top "
        "of a resume summary for the given job — across ANY occupation. "
        "Prefer concrete skills from allowed_vocab & jd_keywords; avoid buzzwords."
    )
    short_jd = _trim(jd_text, 3000)
    short_vocab = allowed_vocab[:120]
    short_kws = jd_keywords[:30]
    ban = [b.lower().strip() for b in (banlist or []) if b]

    user = json.dumps({
        "job_title": job_title, "job_description": short_jd,
        "allowed_vocab": short_vocab, "jd_keywords": short_kws, "banlist": ban
    }, ensure_ascii=False)

    obj = _openai_json(api_key, model, system, user, expect="object", max_tokens=600) or {}
    sentence = _collapse_ws(str(obj.get("summary_sentence") or "")) or \
               _collapse_ws(f"Targeted for {job_title}: hands-on with {', '.join(jd_keywords[:6])}.")
    kws = [str(k).strip() for k in (obj.get("keywords") or []) if k]
    kws = [k for k in kws if k.lower() not in ban]
    return {"summary_sentence": sentence, "keywords": (kws[:12] if kws else jd_keywords[:12]), "notes": obj.get("notes") or ""}
