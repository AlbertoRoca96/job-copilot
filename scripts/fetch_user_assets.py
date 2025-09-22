import os, sys, json, requests, argparse

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SRK = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

def get_json(url):
    r = requests.get(url, headers={"apikey": SRK, "Authorization": f"Bearer {SRK}"}, timeout=20)
    r.raise_for_status()
    return r.json()

def download_object(bucket: str, path: str, out_path: str):
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{path}"
    r = requests.get(url, headers={"Authorization": f"Bearer {SRK}"}, timeout=60)
    r.raise_for_status()
    with open(out_path, "wb") as f:
        f.write(r.content)

def latest_resume(user_id: str):
    url = f"{SUPABASE_URL}/rest/v1/resumes?user_id=eq.{user_id}&select=*&order=created_at.desc&limit=1"
    rows = get_json(url)
    return rows[0] if rows else None

def main(user_id: str):
    row = latest_resume(user_id)
    if not row:
        print("No resume found for user:", user_id)
        sys.exit(0)
    bucket = row.get("bucket", "resumes")
    path = row["path"]
    os.makedirs("assets", exist_ok=True)
    out = "assets/Resume-2025.docx"
    download_object(bucket, path, out)
    print("Downloaded resume ->", out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    args = ap.parse_args()
    main(args.user)
