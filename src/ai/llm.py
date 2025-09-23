# src/ai/llm.py
import os
import json
import re
from typing import Dict, List, Any, Tuple

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

# -------------------- OpenAI call --------------------

def _openai_structured_request(
    api_key: str,
    model: str,
    system: str,
    user: str,
    schema: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Minimal JSON-structured generation using OpenAI Chat Completions.
    Returns parsed JSON dict or {} on failure.
    """
    url = "https://api.openai.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    # We ask for JSON via response_format
    payload = {
        "model": model,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        # conservative
        "temperature": 0.2,
        "max_tokens": 600,
    }

    try:
        r = requests.post(url, headers=headers, json=payload, timeout=45)
        r.raise_for_status()
        data = r.json()
        txt = data["choices"][0]["message"]["content"]
        obj = _json_loads_safe(txt) or {}
        # Best-effort schema check
        if not isinstance(obj, dict):
            return {}
        # Shallow prune to declared keys
        keep = {k: obj.get(k) for k in schema.keys()}
        return keep
    except Exception:
        return {}

# -------------------- public API --------------------

def suggest_policies(api_key: str, title: str, jd_text: str,
                     allowed_vocab: List[str], jd_keywords: List[str],
                     banned: List[str]) -> List[Dict[str, Any]]:
    """
    Your existing entry point (kept for backwards-compat). We leave it as-is
    so earlier callers don’t break. If you want to keep using it elsewhere,
    it can still return tailored clauses (not needed for resume injection).
    """
    # Keep your older behavior or return empty to rely on the new function.
    return []

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
      - summary_sentence: one-liner for resume summary
      - keywords: compact keyword list (for doc props / ATS)
      - notes: brief reason (for debugging)
    If api_key is missing or USE_LLM=0, returns a deterministic fallback.
    """
    # Fallback (deterministic) if LLM disabled
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

    # Keep user content compact to keep latency down
    short_jd = _trim(jd_text, 3000)
    short_vocab = allowed_vocab[:120]  # keep prompt lean
    short_kws = jd_keywords[:30]
    ban = [b.lower().strip() for b in (banlist or []) if b]

    user = (
        json.dumps({
            "job_title": job_title,
            "job_description": short_jd,
            "allowed_vocab": short_vocab,
            "jd_keywords": short_kws,
            "banlist": ban
        }, ensure_ascii=False)
    )

    schema = {
        "summary_sentence": "string",
        "keywords": "array",
        "notes": "string",
    }

    obj = _openai_structured_request(
        api_key=api_key,
        model=model,
        system=system,
        user=user,
        schema=schema,
    ) or {}

    # Guardrails
    sentence = _collapse_ws(str(obj.get("summary_sentence") or ""))
    if not sentence:
        # Cheap backstop
        top = ", ".join(jd_keywords[:6]) if jd_keywords else ""
        sentence = f"Targeted for {job_title}: hands-on with {top}."
    kws = [str(k).strip() for k in (obj.get("keywords") or []) if k]
    # Enforce banlist
    kws = [k for k in kws if k.lower() not in ban]

    return {
        "summary_sentence": sentence,
        "keywords": (kws[:12] if kws else jd_keywords[:12]),
        "notes": obj.get("notes") or "",
    }
