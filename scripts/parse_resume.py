import os, re, json, requests, argparse
from docx import Document

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SRK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

PHONE_RE = re.compile(r"(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

KNOWN_SKILLS = {
  "python","pytorch","opencv","javascript","typescript","react","react native","expo",
  "flask","sql","postgresql","plpgsql","linux","github actions","playwright",
  "hugging face","pwa","service worker","resnet","computer vision","c","c++","java","html","css"
}

def tokens(text: str):
  return set(w.lower() for w in re.findall(r"[A-Za-z][A-Za-z0-9+.-]{1,}", text or ""))

def extract(docx_path: str):
  doc = Document(docx_path)
  full = "\n".join(p.text for p in doc.paragraphs)
  phone_m = PHONE_RE.search(full)
  email_m = EMAIL_RE.search(full)
  phone = phone_m.group(0) if phone_m else None
  email = email_m.group(0) if email_m else None
  toks = tokens(full)
  skills = sorted([s for s in KNOWN_SKILLS if any(t in s or s in t for t in toks)])
  name = None
  for p in doc.paragraphs[:8]:
    t = (p.text or "").strip()
    if t and len(t.split())<=4 and not EMAIL_RE.search(t) and not PHONE_RE.search(t):
      name = t; break
  return {"full_name": name, "email": email, "phone": phone, "skills": skills}

def patch_profile(user_id: str, profile: dict):
  # Replace only the fields we set (arrays are replaced entirely)
  url = f"{SUPABASE_URL}/rest/v1/profiles?id=eq.{user_id}"
  r = requests.patch(url,
    headers={"Content-Type":"application/json","apikey":SRK,"Authorization":f"Bearer {SRK}","Prefer":"return=minimal"},
    data=json.dumps(profile), timeout=30)
  r.raise_for_status()

def main(user_id: str):
  path = "assets/Resume-2025.docx"
  if not os.path.exists(path):
    print("No resume at", path); return
  prof = extract(path)
  prof = {k:v for k,v in prof.items() if v is not None}
  if not prof:
    print("No fields extracted."); return
  patch_profile(user_id, prof)
  print("Patched profile (skills/name/email/phone replaced).")

if __name__ == "__main__":
  ap = argparse.ArgumentParser(); ap.add_argument("--user", required=True)
  main(ap.parse_args().user)
