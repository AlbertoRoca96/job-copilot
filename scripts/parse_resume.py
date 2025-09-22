# scripts/parse_resume.py
import os, re, json, requests, argparse
from docx import Document

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SRK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

# very light heuristics; expand as needed
PHONE_RE = re.compile(r"(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

KNOWN_SKILLS = {
  "python","pytorch","opencv","javascript","typescript","react","react native","expo",
  "flask","sql","postgresql","plpgsql","linux","github actions","playwright",
  "hugging face","pwa","service worker","resnet","computer vision","c","c++","java","html","css"
}

def tokens(text: str):
  return set(w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9+.-]{1,}", text))

def extract(docx_path: str):
  doc = Document(docx_path)
  full = "\n".join(p.text for p in doc.paragraphs)
  phone = (PHONE_RE.search(full) or [None])[0]
  email = (EMAIL_RE.search(full) or [None])[0]
  toks = tokens(full)
  skills = sorted([s for s in KNOWN_SKILLS if any(t in s or s in t for t in toks)])
  name = None
  # naive: first non-empty centered-ish heading or top two words
  for p in doc.paragraphs[:8]:
    t = p.text.strip()
    if t and len(t.split())<=4 and not EMAIL_RE.search(t) and not PHONE_RE.search(t):
      name = t; break
  return {"full_name": name, "email": email, "phone": phone, "skills": skills}

def upsert_profile(user_id: str, profile: dict):
  profile["id"] = user_id
  url = f"{SUPABASE_URL}/rest/v1/profiles"
  r = requests.post(url,
    headers={"Content-Type":"application/json","apikey":SRK,"Authorization":f"Bearer {SRK}","Prefer":"resolution=merge-duplicates"},
    data=json.dumps(profile), timeout=30)
  r.raise_for_status()

def main(user_id: str):
  path = "assets/Resume-2025.docx"
  if not os.path.exists(path): 
    print("No resume at", path); return
  prof = extract(path)
  upsert_profile(user_id, {k:v for k,v in prof.items() if v})
  print("Upserted profile with extracted fields.")

if __name__ == "__main__":
  ap = argparse.ArgumentParser(); ap.add_argument("--user", required=True)
  main(ap.parse_args().user)
