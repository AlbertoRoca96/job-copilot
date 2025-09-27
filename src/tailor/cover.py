# src/tailor/cover.py
#!/usr/bin/env python3
import os, re, json
from typing import Dict, List, Any, Optional, Tuple
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from src.ai.llm import craft_cover_sections

UA = "job-copilot/1.0 (+https://github.com/AlbertoRoca96/job-copilot)"
TIMEOUT = (10, 20)  # connect, read

# ----------------------- utils -----------------------
_WORD = re.compile(r"[A-Za-z][A-Za-z0-9+./-]{1,}")

def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()

def _tokens(text: str) -> List[str]:
    return _WORD.findall((text or "").lower())

def _dedupe_keep_order(xs: List[str]) -> List[str]:
    seen, out = set(), []
    for x in xs:
        if x and x not in seen:
            out.append(x); seen.add(x)
    return out

# ----------------------- company context -----------------------
def _host_from_url(url: str) -> str:
    try:
        return urlparse(url).netloc or ""
    except Exception:
        return ""

def _maybe_company_root(url: str) -> Optional[str]:
    host = _host_from_url(url)
    if not host: return None
    scheme = "https://" if not host.startswith(("http://","https://")) else ""
    return f"{scheme}{host}"

def _fetch(url: str) -> str:
    try:
        r = requests.get(url, headers={"User-Agent": UA, "Accept-Language":"en-US,en;q=0.8"},
                         timeout=TIMEOUT, allow_redirects=True)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        for t in soup(["script","style","noscript","svg","img","nav","header","footer","form"]):
            t.decompose()
        main = soup.select_one("main, article, .content, #content, .page, body") or soup
        return _norm_ws(main.get_text(" ", strip=True))[:4000]
    except Exception:
        return ""

def get_company_context(job: Dict[str, Any]) -> Dict[str, Any]:
    """
    Best-effort: pull a few hundred chars from company root and common 'about/values' pages.
    Non-fatal; returns empty strings if blocked.
    """
    url = (job.get("url") or "").strip()
    company = (job.get("company") or "").strip()
    ctx = {"company": company, "site_text": "", "about_text": "", "values_text": ""}

    root = _maybe_company_root(url)
    if not root:
        return ctx

    root_txt = _fetch(root)
    about_txt = _fetch(root.rstrip("/") + "/about")
    values_txt = _fetch(root.rstrip("/") + "/values")

    ctx["site_text"] = root_txt
    ctx["about_text"] = about_txt
    ctx["values_text"] = values_txt
    return ctx

def pick_company_themes(ctx: Dict[str, str], cap: int = 5) -> List[str]:
    """
    Very lightweight theme miner for values/mission/keywords; not ML—just frequency + whitelist hints.
    """
    txt = " ".join([ctx.get("values_text",""), ctx.get("about_text",""), ctx.get("site_text","")]).lower()
    if not txt: return []

    whitelist = [
        "customer", "patients", "innovation", "quality", "safety", "integrity", "ownership",
        "impact", "learning", "craft", "excellence", "inclusion", "diversity", "equity",
        "sustainability", "community", "privacy", "security", "open source", "collaboration",
        "reliability", "performance", "accessibility"
    ]
    scores = {}
    for w in whitelist:
        c = len(re.findall(rf"\b{re.escape(w)}\b", txt))
        if c:
            scores[w] = c
    return [k for k,_ in sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))][:cap]

# ----------------------- cover composition -----------------------
def generate_cover_letter(job: Dict[str, Any],
                          profile: Dict[str, Any],
                          jd_text: str,
                          jd_keywords: List[str],
                          allowed_vocab: List[str],
                          tone: str = "professional") -> str:
    """
    Returns a finished Markdown cover letter, preferring LLM JSON sections.
    Falls back to a deterministic template if no API key is set.
    """
    api_key = os.getenv("OPENAI_API_KEY", "")
    model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

    company_ctx = get_company_context(job)
    company_themes = pick_company_themes(company_ctx)

    if api_key:
        sections = craft_cover_sections(
            api_key=api_key,
            model=model,
            job_title=job.get("title",""),
            company=job.get("company",""),
            jd_text=jd_text,
            profile=profile or {},
            allowed_vocab=allowed_vocab or [],
            jd_keywords=jd_keywords or [],
            company_context={
                "themes": company_themes,
                "snippets": {
                    "about": company_ctx.get("about_text","")[:1200],
                    "values": company_ctx.get("values_text","")[:1200]
                }
            },
            tone=tone
        ) or {}

        # If the model responded, stitch to Markdown and return.
        if sections.get("opening_hook"):
            lines = []
            if sections.get("greeting"):
                lines.append(sections["greeting"])
                lines.append("")
            lines.append(sections["opening_hook"])
            if sections.get("evidence_1"):
                lines.append("")
                lines.append(sections["evidence_1"])
            if sections.get("evidence_2"):
                lines.append("")
                lines.append(sections["evidence_2"])
            if sections.get("company_alignment"):
                lines.append("")
                lines.append("**Why " + (job.get("company","") or "this team") + "?**")
                for b in sections["company_alignment"]:
                    lines.append(f"- {b}")
            if sections.get("closing"):
                lines.append("")
                lines.append(sections["closing"])
            if sections.get("signature"):
                lines.append("")
                lines.append(sections["signature"])
            return "\n".join(lines).rstrip()

    # -------- fallback (no API key or empty LLM response) --------
    full_name = (profile or {}).get("full_name") or ""
    contact_line = " | ".join([x for x in [(profile or {}).get("email"), (profile or {}).get("phone")] if x])

    hook_bits = ", ".join(_dedupe_keep_order((jd_keywords or [])[:6])) or "skills the role emphasizes"
    theme_line = ", ".join(company_themes[:3]) if company_themes else "your team’s goals"

    greeting = f"Dear Hiring Team at {job.get('company','')},".strip().rstrip(",") + ","
    opening = (
        f"I'm excited to apply for the **{job.get('title','')}** role at **{job.get('company','')}**. "
        f"My background maps closely to the posting—hands-on with {hook_bits}."
    )

    body1 = (
        "In prior roles, I delivered measurable outcomes by aligning day-to-day execution to clear priorities. "
        "I favor tight feedback loops, concise communication, and documentation that reduces rework."
    )
    body2 = (
        "I’m motivated by environments that value learning, ownership, and collaboration. "
        f"That’s a strong fit for {job.get('company','')}—especially around {theme_line}."
    )
    closing = (
        "I’d welcome the chance to dive deeper into relevant projects and how I can help the team deliver impact. "
        "Thank you for your time and consideration."
    )
    sig = "\n".join(filter(None, [full_name, contact_line]))

    bullet_block = ""
    if company_themes:
        bullet_block = "\n\n**Why this team**\n" + "\n".join([f"- {t.title()}" for t in company_themes[:4]])

    return "\n".join([greeting, "", opening, "", body1, "", body2, bullet_block, "", closing, "", sig]).strip()
