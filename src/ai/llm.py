# src/ai/llm.py
import os, json, requests

OPENAI_URL = "https://api.openai.com/v1/chat/completions"
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")  # tweak if you like

_SYSTEM = """You are a careful resume-tailoring assistant.
Return compact JSON ONLY. Do not fabricate experience or years.
You may propose at most 5 short, honest clauses that align to this job description,
and only if the candidate’s allowed skills cover the technologies mentioned.
Each suggestion must target a bullet 'context' (like model, pipeline, search, product, ci, nlp, vision, database).
Keep each clause under 14 words, neutral tone, resume-ready, no salesy adjectives."""

_USER_TMPL = """JOB TITLE:
{title}

JOB DESCRIPTION:
{desc}

ALLOWED VOCAB (candidate truly has/claims):
{vocab}

RETURN JSON (list of objects) with keys:
  - clause: short sentence fragment to append (no period at end)
  - context: one of [model,pipeline,search,rag,product,ci,nlp,vision,database,frontend,mobile]
  - requires_any: list of 1-3 items from allowed vocab this clause relies on

Rules:
- Use only technologies present in BOTH the JD and allowed vocab.
- Prefer model/pipeline/search/product/ci contexts.
- 3-5 items max.
- JSON only; no markdown, no prose."""

def _post(api_key: str, messages):
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    body = {"model": MODEL, "messages": messages, "temperature": 0.2, "max_tokens": 600}
    r = requests.post(OPENAI_URL, headers=headers, json=body, timeout=45)
    r.raise_for_status()
    return r.json()

def suggest_policies(api_key: str, job_title: str, job_desc: str, allowed_vocab: list[str]) -> list[dict]:
    if not api_key:
        return []
    prompt = _USER_TMPL.format(title=job_title or "", desc=job_desc or "", vocab=", ".join(sorted(set(allowed_vocab))))
    try:
        data = _post(api_key, [
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": prompt},
        ])
        content = data["choices"][0]["message"]["content"].strip()
        items = json.loads(content)
        out = []
        for i, it in enumerate(items[:5]):
            clause = (it.get("clause") or "").strip().strip(".")
            ctx = (it.get("context") or "").strip().lower()
            req = [str(x).strip().lower() for x in (it.get("requires_any") or [])][:3]
            if clause and ctx:
                # map simple contexts to bullet cue tokens
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
                    "jd_cues": [],                    # we rely on JD parse elsewhere
                    "bullet_cues": list(set(bullet_cues)),
                    "requires_any": list(set(req)),
                    "clause": clause,
                })
        return out
    except Exception:
        # If the call fails, just fall back to deterministic rules
        return []
