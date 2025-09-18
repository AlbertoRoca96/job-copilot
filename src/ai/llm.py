# src/ai/llm.py
import os, json, requests

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

_SYSTEM = """You are a careful resume-tailoring assistant.
Return compact JSON ONLY. Do not fabricate experience or years.
Use the job description provided verbatim to guide suggestions.
Suggest short, honest clauses to APPEND to existing bullets (not whole bullets).
Each clause is <= 14 words, declarative, neutral tone, resume-ready.
No buzzwords, no adjectives like 'world-class', no exaggeration."""

_USER_TMPL = """JOB TITLE:
{title}

JOB DESCRIPTION (plain text; trimmed):
{desc}

ALLOWED VOCAB (candidate truly claims):
{vocab}

RETURN JSON (array) with objects:
  - clause: short sentence fragment to append (no trailing period)
  - context: one of [model,pipeline,search,rag,product,ci,nlp,vision,database,frontend,mobile,cxx,performance,wasm,multiplayer,api,accessibility]
  - requires_any: list of 1-3 tokens from ALLOWED VOCAB that justify the clause

HARD RULES:
- Use ONLY technologies/terms present in BOTH the JD AND ALLOWED VOCAB.
- Avoid generic words (FORBIDDEN: ai, automation, workflows, cutting-edge, world-class, synergy).
- Each suggestion must cover a DIFFERENT context (no repeated contexts).
- Prefer concrete JD terms (e.g., 'ranking', 'retrieval', 'WebAssembly', 'multiplayer', 'SceneGraph') when in ALLOWED VOCAB.
- 3 to 5 items total.
- No markdown, ONLY valid JSON."""

def _post(api_key: str, messages):
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body = {"model": MODEL, "messages": messages, "temperature": 0.2, "max_tokens": 600}
    r = requests.post(OPENAI_URL, headers=headers, json=body, timeout=45)
    r.raise_for_status()
    return r.json()

def suggest_policies(api_key: str, job_title: str, job_desc: str, allowed_vocab: list[str]) -> list[dict]:
    if not api_key:
        return []
    desc = (job_desc or "")[:8000]  # token safety
    prompt = _USER_TMPL.format(
        title=job_title or "",
        desc=desc,
        vocab=", ".join(sorted(set(allowed_vocab)))
    )
    try:
        data = _post(api_key, [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": prompt},
        ])
        content = data["choices"][0]["message"]["content"].strip()
        items = json.loads(content)
        out = []
        seen_clause = set()
        seen_ctx = set()
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
            "frontend": ["react","ui","component","typescript"],
            "mobile": ["react native","expo","mobile"],
            "cxx": ["c++","cpp","opencv"],
            "performance": ["performance","latency","memory","optimize"],
            "wasm": ["wasm","webassembly"],
            "multiplayer": ["multiplayer","protocol","collaboration"],
            "api": ["api","sdk","interface","tooling"],
            "accessibility": ["accessibility","a11y"],
        }
        for i, it in enumerate(items[:5]):
            clause = (it.get("clause") or "").strip().strip(".")
            ctx = (it.get("context") or "").strip().lower()
            req = [str(x).strip().lower() for x in (it.get("requires_any") or [])][:3]
            if not clause or not ctx or clause.lower() in seen_clause or ctx in seen_ctx:
                continue
            seen_clause.add(clause.lower()); seen_ctx.add(ctx)
            bullet_cues = CUE_MAP.get(ctx, [ctx])
            out.append({
                "id": f"llm_{i}",
                "jd_cues": [],  # caller adds JD cues
                "bullet_cues": list(set(bullet_cues)),
                "requires_any": list(set(req)),
                "clause": clause,
            })
        return out
    except Exception:
        return []
