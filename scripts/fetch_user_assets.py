# scripts/fetch_user_assets.py
import os, sys, requests, argparse

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SRK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def query(q):
  r = requests.get(q, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=30)
  r.raise_for_status(); return r.json()

def download(bucket, path, out_path):
  url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}"
  r = requests.get(url, headers={"Authorization": f"Bearer {SRK}"}, timeout=60)
  r.raise_for_status()
  os.makedirs(os.path.dirname(out_path), exist_ok=True)
  with open(out_path, "wb") as f: f.write(r.content)

def main(user_id):
  rows = query(f"{SUPABASE_URL}/rest/v1/resumes?user_id=eq.{user_id}&select=*&order=created_at.desc&limit=1")
  if not rows: 
    print("No resume for user", user_id); return
  row = rows[0]
  download(row["bucket"], row["path"], "assets/Resume-2025.docx")
  print("Downloaded resume -> assets/Resume-2025.docx")

if __name__ == "__main__":
  ap = argparse.ArgumentParser(); ap.add_argument("--user", required=True)
  main(ap.parse_args().user)
