# src/ai/llm.py
import os, json, requests

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
# Prefer a strong default; allow override via OPENAI_MODEL.
# Suggest gpt-5 if available; fall back gracefully.
MODEL = os.getenv("OPENAI_MODEL", "gpt-5")

_SYSTEM = """You are a careful resume-tailoring assistant.
Return compact JSON ONLY. Do not fabricate experience or years.
Use the job description provided verbatim to guide suggestions.
Suggest short, honest clauses to APPEND to existing bullets (not whole bullets).
Each clause must be <= 14 words, declarative, neutral tone, resume-ready.
No buzzwords, no adjectives, no exaggeration.
Clauses must be readable for humans (not keyword dumps) while remaining ATS-friendly.
Avoid passive voice and vague words (optimize, various, multiple). Prefer concrete actions.
"""

_USER_TMPL = """JOB TITLE:
{title}

ALLOWED VOCAB (candidate truly claims; lowercase):
{vocab}

JD TERMS (exact strings extracted from this JD; lowercase):
{jd_terms}

BANLIST (previously used clauses you MUST NOT repeat; lowercase):
{banlist}

JOB DESCRIPTION (plain text; trimmed):
{desc}

RETURN JSON (array) of 3–5 items. Each has:
  - clause: short fragment to append (no trailing period)
  - context: one of [model,pipeline,search,rag,product,ci,nlp,vision,database,frontend,mobile]
  - requires_any: 1–3 tokens from ALLOWED VOCAB that justify the clause
  - uses: 1–2 items copied verbatim from JD TERMS that the clause actually mentions

HARD RULES:
- A clause is valid ONLY if:
  (a) every technology mentioned appears in BOTH the JD and ALLOWED VOCAB, and
  (b) the clause includes at least one string from JD TERMS (put it in "uses"), and
  (c) it does not exactly match any string in BANLIST, and
  (d) it is semantically distinct from the other clauses (different context/idea).
- Do not output markdown. ONLY valid JSON.
"""

def _post(api_key: str, messages):
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body = {"model": MODEL, "messages": messages, "temperature": 0.2, "max_tokens": 650}
    r = requests.post(OPENAI_URL, headers=headers, json=body, timeout=45)
    r.raise_for_status()
    return r.json()

def suggest_policies(api_key: str, job_title: str, job_desc: str,
                     allowed_vocab: list[str], jd_terms: list[str], banlist: list[str]) -> list[dict]:
    if not api_key:
        return []

    # Limit size for safety
    desc = (job_desc or "")[:8000]
    prompt = _USER_TMPL.format(
        title=job_title or "",
        desc=desc,
        vocab=", ".join(sorted(set(x.lower() for x in allowed_vocab))),
        jd_terms=", ".join(sorted(set(x.lower() for x in jd_terms))),
        banlist=", ".join(sorted(set(x.lower() for x in banlist))),
    )

    try:
        data = _post(api_key, [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": prompt},
        ])
        content = data["choices"][0]["message"]["content"].strip()
        # Some models may wrap JSON in code fences; strip if necessary
content = content.strip()
if content.startswith("```"):
    content = content.strip("`\n ")
    # remove a possible json hint
    if content.lower().startswith("json"):
        content = content[4:].lstrip()
items = json.loads(content)

        out, seen = [], set()
        for i, it in enumerate(items[:6]):  # allow up to 6; we will filter later
            clause = (it.get("clause") or "").strip().strip(".").lower()
            ctx = (it.get("context") or "").strip().lower()
            req = [str(x).strip().lower() for x in (it.get("requires_any") or [])][:3]
            uses = [str(x).strip().lower() for x in (it.get("uses") or [])][:2]

            if not clause or clause in seen or clause in (x.lower() for x in banlist):
                continue
            if not ctx or not req or not uses:
                continue

            # Basic quality/readability gates
            # - no repeated token spam
            # - avoid all-caps or weird punctuation
            # - keep length 4..14 words
            wds = [w for w in clause.split() if w.strip()]
            if not (4 <= len(wds) <= 14):
                continue
            if any(len(w) > 24 for w in wds):
                continue
            # simple spam detection: too many commas or slashes
            if clause.count(',') > 2 or clause.count('/') > 2:
                continue
            # must contain at least one ALLOWED token and one JD term
            if not any(tok in clause for tok in req):
                continue
            if not any(tok in clause for tok in uses):
                continue

            # Minimal shape; bullet cues inferred from context
            CUE_MAP = {
                "model": ["model","pytorch","tensorflow","resnet","inference","classification","training"],
                "pipeline": ["pipeline","cron","github","actions","sql","postgres","dataset","annotation","etl"],
                "search": ["search","ranking","retrieve","index","vector","embedding","relevance"],
                "rag": ["retrieval","rag","chunk","embedding","index"],
                "product": ["app","ui","pwa","react","prototype","feature"],
                "ci": ["ci","monitor","deploy","github","actions","workflow"],
                "nlp": ["language","nlp","text","token"],
                "vision": ["vision","opencv","image","resnet"],
                "database": ["database","sql","postgres","supabase"],
                "frontend": ["react","ui","component"],
                "mobile": ["react native","expo","mobile"],
            }
            bullet_cues = CUE_MAP.get(ctx, [ctx])

            out.append({
                "id": f"llm_{i}",
                "jd_cues": list(set(uses)),      # caller also seeds jd_cues
                "bullet_cues": list(set(bullet_cues)),
                "requires_any": list(set(req)),
                "clause": clause,
            })
            seen.add(clause)
        return out
    except Exception:
        # Best-effort: no LLM means deterministic-only tailoring
        return []
