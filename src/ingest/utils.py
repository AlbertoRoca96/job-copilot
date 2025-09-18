import requests, time

HEADERS = {'User-Agent': 'job-copilot/0.1 (+github starter)'}

def get_json(url: str, retries: int = 3, timeout: int = 20):
    for i in range(retries):
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        if r.status_code == 200:
            try:
                return r.json()
            except Exception:
                return None
        time.sleep(1 + i)
    return None

def get_text(url: str, retries: int = 3, timeout: int = 20):
    for i in range(retries):
        r = requests.get(url, headers=HEADERS, timeout=timeout)
        if r.status_code == 200:
            return r.text
        time.sleep(1 + i)
    return ""
