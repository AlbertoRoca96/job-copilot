import os
import json
import re
from typing import Dict, List, Any, Optional

import requests

# ----------------------------- small utils -----------------------------
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

# ----------------------------- OpenAI JSON helper -----------------------------
def _openai_json(
    api_key: str,
    model: str,
    system: str,
    user: str,
    expect: str = "object",
    max_tokens: int = 900,
    temperature: float = 0.2,
) -> Any:
    """
    Minimal, dependency-light JSON-mode chat wrapper using requests.
    """
    url = "https://api.openai.com/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "response_format": (
            {"type": "json_object"}
            if expect == "object"
            else {"type": "json_schema", "json_schema": {"name": "arr", "schema": {"type": "object", "properties": {"items": {"type": "array"}}}}}
        ),
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
            if isinstance(obj, list):
                return obj
            if isinstance(obj, dict) and isinstance(obj.get("policies"), list):
                return obj["policies"]
            return []
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return [] if expect == "array" else {}

# ----------------------------- existing exports -----------------------------
def suggest_policies(
    api_key: str,
    title: str,
    jd_text: str,
    allowed_vocab: List[str],
    jd_keywords: List[str],
    banned: List[str],
) -> List[Dict[str, Any]]:
    """
    Generate concise, job-aligned clauses to append to existing bullets for ANY occupation.
    Each item: { clause, jd_cues, bullet_cues }
      - clause: ≤ 18 words, concrete, human + ATS friendly, no semicolons
      - jd_cues: 3–6 key tokens from the job description/keywords
      - bullet_cues: 2–5 tokens likely present in the source bullet (to gate placement)
    """
    if not api_key:
        return []

    system = (
        "You write short, concrete add-on phrases for resume bullets across ANY occupation "
        "(e.g., retail, healthcare, logistics, editorial, trades, hospitality, tech). "
        "Output JSON array items: {\"clause\": string, \"jd_cues\": [string], \"bullet_cues\": [string]}. "
        "Clauses must be ≤18 words, avoid buzzwords, no semicolons, and read naturally when appended. "
        "Prefer skills in allowed_vocab and jd_keywords; exclude anything in banlist."
    )
    user = json.dumps(
        {
            "job_title": title,
            "job_description": _trim(jd_text, 4500),
            "allowed_vocab": allowed_vocab[:160],
            "jd_keywords": jd_keywords[:40],
            "banlist": [b.strip().lower() for b in banned if b],
            "target_count": 8,
        },
        ensure_ascii=False,
    )

    arr = _openai_json(api_key, os.getenv("OPENAI_MODEL", "gpt-4o-mini"), system, user, expect="array", max_tokens=900) or []

    out = []
    ban = {b.strip().lower() for b in (banned or []) if b}
    for it in arr:
        clause = _collapse_ws(str((it or {}).get("clause") or ""))
        if not clause:
            continue
        if any(tok in clause.lower() for tok in (";", "  ")):
            continue
        if len(clause.split()) < 4 or len(clause.split()) > 18:
            continue
        if clause.lower() in ban:
            continue
        jd_cues = [str(x).strip().lower() for x in (it.get("jd_cues") or []) if x][:6]
        bullet_map = [str(x).strip().lower() for x in (it.get("bullet_cues") or []) if x][:5]
        out.append({"clause": clause, "jd_cues": jd_cues, "bullet_cues": bullet_map, "_source": "runtime"})
        ban.add(clause.lower())
    return out


def craft_tailored_snippets(
    api_key: Optional[str],
    model: str,
    job_title: str,
    jd_text: str,
    profile: Dict[str, Any],
    allowed_vocab: List[str],
    jd_keywords: List[str],
    banlist: List[str],
) -> Dict[str, Any]:
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

    user = json.dumps(
        {"job_title": job_title, "job_description": short_jd, "allowed_vocab": short_vocab, "jd_keywords": short_kws, "banlist": ban},
        ensure_ascii=False,
    )

    obj = _openai_json(api_key, model, system, user, expect="object", max_tokens=600) or {}
    sentence = _collapse_ws(str(obj.get("summary_sentence") or "")) or _collapse_ws(
        f"Targeted for {job_title}: hands-on with {', '.join(jd_keywords[:6])}."
    )
    kws = [str(k).strip() for k in (obj.get("keywords") or []) if k]
    kws = [k for k in kws if k.lower() not in ban]
    return {"summary_sentence": sentence, "keywords": (kws[:12] if kws else jd_keywords[:12]), "notes": obj.get("notes") or ""}

# ----------------------------- NEW: cover-letter planner -----------------------------
def craft_cover_letter(
    api_key: Optional[str],
    model: str,
    job: Dict[str, Any],
    jd_text: str,
    profile: Dict[str, Any],
    jd_keywords: List[str],
    company_blurbs: Dict[str, str],
    *,
    tone: str = "professional",
    paragraphs: int = 4,
    max_words: int = 400,
    contact_name: str = "",
) -> Dict[str, Any]:
    """
    Returns a structured plan for a tailored cover letter.

    Output schema:
    {
      "greeting_name": "Hiring Manager",
      "intro": "...",
      "evidence": ["...", "..."],  # 1-3 short paragraphs or bullets
      "why_company": "...",
      "closing": "...",
      "signoff": "Best regards",
      "layout": "3-5p",
      "tone": "professional"
    }
    """
    # defensive defaults
    paragraphs = max(3, min(5, int(paragraphs or 4)))
    max_words = max(250, min(650, int(max_words or 400)))

    # If no API, make a deterministic, concise plan.
    if not api_key:
        company = (job.get("company") or "").strip()
        hook_bits = ", ".join([k for k in jd_keywords[:6] if k])
        about = _collapse_ws(company_blurbs.get("about") or "")[:200]
        why = f"I’m drawn to {company} because {about}" if (company and about) else f"I’m drawn to this opportunity because it aligns with my background in {hook_bits}."
        intro = f"I’m excited to apply for the {job.get('title','')} role, bringing hands-on experience with {hook_bits}."
        evidence = [
            f"In prior roles I supported work involving {', '.join(jd_keywords[:4])}. I focus on clear communication, reliable execution, and measurable outcomes.",
        ]
        closing = "I’d welcome the chance to discuss how I can contribute and hit the ground running in the first 90 days."
        return {
            "greeting_name": contact_name or ("Hiring Team" if not company else f"{company} Hiring Team"),
            "intro": _collapse_ws(intro)[:max_words],
            "evidence": evidence,
            "why_company": _collapse_ws(why)[:max_words],
            "closing": closing,
            "signoff": "Best regards",
            "layout": f"{paragraphs}p",
            "tone": tone,
        }

    # LLM path
    system = (
        "You are a meticulous cover-letter planner. Design a natural, tailored letter for ANY occupation "
        "(tech, healthcare, retail, logistics, hospitality, editorial, trades, etc.). "
        "STRICT Rules: 1) ≤ one page (~3–5 short paragraphs, ≤{max_words} words); "
        "2) align directly to the job description; 3) show concrete impact without fabricating metrics; "
        "4) optionally reference company mission/products/values using the brief company context; "
        "5) professional but warm tone; 6) no buzzword stuffing; 7) JSON output only."
    ).format(max_words=max_words)

    user = json.dumps(
        {
            "job": {
                "title": job.get("title", ""),
                "company": job.get("company", ""),
                "location": job.get("location", ""),
                "url": job.get("url", ""),
            },
            "jd_text": _trim(jd_text, 5000),
            "profile": {
                "full_name": profile.get("full_name") or "",
                "skills": profile.get("skills") or [],
                "target_titles": profile.get("target_titles") or [],
            },
            "jd_keywords": jd_keywords[:24],
            "company": {
                "about": _trim(company_blurbs.get("about") or "", 900),
                "values": _trim(company_blurbs.get("values") or "", 600),
                "products": _trim(company_blurbs.get("products") or "", 600),
            },
            "tone": tone,
            "paragraphs": paragraphs,
            "max_words": max_words,
            "contact_name": contact_name or "",
        },
        ensure_ascii=False,
    )

    obj = _openai_json(api_key, model, system, user, expect="object", max_tokens=900) or {}
    # sanitize / clamp
    greeting = str(obj.get("greeting_name") or (contact_name or "Hiring Manager")).strip()
    intro = _collapse_ws(str(obj.get("intro") or ""))[:max_words]
    ev = [ _collapse_ws(str(x)) for x in (obj.get("evidence") or []) if isinstance(x, str) and x.strip() ][:3]
    why = _collapse_ws(str(obj.get("why_company") or ""))[:max_words]
    closing = _collapse_ws(str(obj.get("closing") or ""))[:max_words]
    sign = _collapse_ws(str(obj.get("signoff") or "Best regards"))
    lay = str(obj.get("layout") or f"{paragraphs}p")

    # robust fallback if the model returns something odd
    if not intro:
        intro = _collapse_ws(f"I’m excited to apply for the {job.get('title','')} role, aligning my background with {', '.join(jd_keywords[:6])}.")
    if not ev:
        ev = [_collapse_ws("In prior roles I delivered results through clear communication, careful execution, and collaboration across teams.")]
    if not why:
        company = (job.get("company") or "").strip()
        about = _collapse_ws(company_blurbs.get("about") or "")
        why = _collapse_ws(f"I’m drawn to {company} because {about}") if (company and about) else "I value teams that prioritize clarity, reliability, and measurable outcomes."
    if not closing:
        closing = "I’d welcome the chance to discuss how I can help in the first 90 days."
    return {
        "greeting_name": greeting,
        "intro": intro,
        "evidence": ev,
        "why_company": why,
        "closing": closing,
        "signoff": sign,
        "layout": lay,
        "tone": tone,
    }
