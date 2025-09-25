# scripts/fetch_user_assets.py
import os, requests, argparse, hashlib

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

def sha1(path):
  h = hashlib.sha1()
  with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(8192), b""):
      h.update(chunk)
  return h.hexdigest()

def main(user_id):
  rows = query(f"{SUPABASE_URL}/rest/v1/resumes?user_id=eq.{user_id}&select=bucket,path,created_at&order=created_at.desc&limit=1")
  if not rows:
    print("No resume for user", user_id); return
  row = rows[0]
  bucket = row.get("bucket") or "resumes"
  path = row["path"]

  out = "assets/current.docx"  # unified
  download(bucket, path, out)
  print(f"Downloaded resume from {bucket}/{path} -> {out} (sha1={sha1(out)})")

if __name__ == "__main__":
  ap = argparse.ArgumentParser(); ap.add_argument("--user", required=True)
  main(ap.parse_args().user)
