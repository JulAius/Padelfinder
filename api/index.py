import asyncio
import json
import os
import re
import urllib.parse
from datetime import datetime
from math import cos, radians
from typing import Optional
from urllib.parse import unquote, urljoin

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

import os
import pathlib

# Vercel environment path adjustment
# When running as api/index.py, we need to point to the project root for data
# Vercel environment path adjustment
# When running as api/index.py, we need to point to the project root for data
BASE_DIR = pathlib.Path(__file__).parent.parent

if os.environ.get("VERCEL") == "1":
    DATA_DIR = "/tmp"
else:
    DATA_DIR = os.path.join(BASE_DIR, "data/tenup")

TOKEN_PATH = os.path.join(DATA_DIR, "token.json")
COOKIE_PATH = os.path.join(DATA_DIR, "cookie.txt")
COOKIE_PATH_ALT = os.path.join(DATA_DIR, "cookies.txt")

TOKEN_URL = "https://login.fft.fr/realms/connect/protocol/openid-connect/token"
API_BASE = "https://api.fft.fr/fft/v1"
TENUP_BASE = "https://tenup.fft.fr"
SEARCH_PATH = "/recherche/tournois"
AJAX_PATH = "/system/ajax"

BASE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json",
    "X-APPLICATION-ID": "tenup-app",
}

WEB_HEADERS = {
    "User-Agent": BASE_HEADERS["User-Agent"],
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "fr-FR,fr;q=0.9,en-US;q=0.8",
    "Cache-Control": "max-age=0",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
}

# ─────────────────────────────────────────────────────────────────────────────
# CACHE CONFIGURATION (TTL: 1 hour)
# ─────────────────────────────────────────────────────────────────────────────
INTERNAL_CACHE = {}
CACHE_TTL = 3600  # 1 hour in seconds

app = FastAPI(title="Padel Mobile API Proxy")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def load_token_file():
    # 1. Try local file (Highest priority - contains refreshed tokens)
    if os.path.exists(TOKEN_PATH):
        try:
            with open(TOKEN_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    # 2. Try environment variable
    env_token = os.environ.get("TENUP_TOKEN")
    if env_token:
        try:
            return json.loads(env_token)
        except Exception as e:
            print(f"Failed to parse TENUP_TOKEN: {e}")
            
    return None


def load_cookie_header() -> Optional[str]:
    env_cookie = os.environ.get("TENUP_COOKIE")
    if env_cookie:
        raw = env_cookie.strip()
        if raw.lower().startswith("cookie:"):
            raw = raw.split(":", 1)[1].strip()
        return raw
    if os.path.exists(COOKIE_PATH):
        try:
            with open(COOKIE_PATH, "r", encoding="utf-8") as f:
                raw = f.read().strip()
                if raw.lower().startswith("cookie:"):
                    raw = raw.split(":", 1)[1].strip()
                # collapse newlines if any
                raw = "; ".join([part.strip() for part in raw.splitlines() if part.strip()])
                return raw
        except Exception:
            return None
    if os.path.exists(COOKIE_PATH_ALT):
        try:
            with open(COOKIE_PATH_ALT, "r", encoding="utf-8") as f:
                raw = f.read().strip()
                if raw.lower().startswith("cookie:"):
                    raw = raw.split(":", 1)[1].strip()
                raw = "; ".join([part.strip() for part in raw.splitlines() if part.strip()])
                return raw
        except Exception:
            return None
    return None


async def fetch_cookie_header_via_playwright() -> str:
    # On Vercel, we can't run Playwright (browsers not installed), so we must fail gracefully
    if os.environ.get("VERCEL") == "1":
        raise RuntimeError("Playwright not supported on Vercel. Please set 'TENUP_COOKIE' env var.")

    # Import lazily to avoid hard dependency at startup
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        await page.goto(TENUP_BASE + SEARCH_PATH, wait_until="networkidle", timeout=60000)
        await page.wait_for_timeout(2000)
        cookies = await context.cookies()
        await browser.close()

    # Keep cookies for tenup.fft.fr only
    tenup_cookies = [c for c in cookies if "tenup.fft.fr" in c.get("domain", "")]
    if not tenup_cookies:
        tenup_cookies = cookies

    header = "; ".join([f"{c['name']}={c['value']}" for c in tenup_cookies])
    if not header:
        raise RuntimeError("Playwright did not return any cookies.")
    # Persist for later use
    os.makedirs(os.path.dirname(COOKIE_PATH_ALT), exist_ok=True)
    with open(COOKIE_PATH_ALT, "w", encoding="utf-8") as f:
        f.write(header)
    return header


def parse_cookie_header(cookie_header: str) -> dict:
    cookies = {}
    for chunk in cookie_header.split(";"):
        if "=" not in chunk:
            continue
        name, value = chunk.split("=", 1)
        name = name.strip()
        value = value.strip()
        if not name:
            continue
        # Encode non-ASCII / spaces to keep headers ASCII-safe
        value = urllib.parse.quote(
            value,
            safe="!#$%&'()*+-.^_`|~/:?@[]{}=,%",
        )
        cookies[name] = value
    return cookies


def save_token_file(data: dict):
    try:
        os.makedirs(os.path.dirname(TOKEN_PATH), exist_ok=True)
        with open(TOKEN_PATH, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=True, indent=2)
    except Exception:
        pass


def normalize_dates(items):
    for it in items:
        if it.get("startDate") and not it.get("dateDebut"):
            it["dateDebut"] = {"date": it["startDate"]}
        if it.get("endDate") and not it.get("dateFin"):
            it["dateFin"] = {"date": it["endDate"]}
    return items


def format_date_for_tenup(date_str: str) -> str:
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
        return dt.strftime("%d/%m/%y")
    except Exception:
        return date_str


async def refresh_access_token(refresh_token: str):
    data = {
        "grant_type": "refresh_token",
        "client_id": "tenup-app",
        "refresh_token": refresh_token,
    }
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-APPLICATION-ID": "tenup-app",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(TOKEN_URL, data=data, headers=headers)
        resp.raise_for_status()
        return resp.json()


async def fetch_mobile_api(
    token: str,
    lat: float,
    lng: float,
    rayon_km: int,
    date_start: str,
    date_end: str,
    level: str,
    limit: int = 100,
):
    params = {
        "practice": "PADEL",
        "latitude": lat,
        "longitude": lng,
        "distance": rayon_km,
        "startDate": date_start,
        "endDate": date_end,
        "offset": 0,
        "limit": limit,
    }
    if level:
        params["categories"] = level

    headers = {
        **BASE_HEADERS,
        "Authorization": f"Bearer {token}",
    }

    url = f"{API_BASE}/competition/tournois"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(url, params=params, headers=headers)
        if resp.status_code == 401:
            raise HTTPException(status_code=401, detail="Token expiré ou invalide. Relance scripts/tenup_auth.py")
        resp.raise_for_status()
        data = resp.json()
        items = data.get("items") or data.get("content") or []
        return normalize_dates(items), data


async def get_form_state(client: httpx.AsyncClient):
    await client.get(TENUP_BASE + "/", follow_redirects=False)
    url = TENUP_BASE + SEARCH_PATH
    html = ""

    for _ in range(5):
        resp = await client.get(url, follow_redirects=False, timeout=20)
        html = resp.text
        current_url = str(resp.url)

        if resp.status_code in (301, 302, 303, 307, 308):
            location = resp.headers.get("location", "")
            if "queue-it.net" in location:
                raise RuntimeError("Queue-it redirection detected; cookies invalid or expired.")
            url = urljoin(TENUP_BASE, location)
            await asyncio.sleep(1)
            continue

        if "queue-it.net" in current_url:
            raise RuntimeError("Queue-it page detected; cookies invalid or expired.")

        if "decodeURIComponent" in html and "cookietest" in html:
            mredir = re.search(r"decodeURIComponent\\('([^']+)'\\)", html)
            if mredir:
                redir_path = unquote(mredir.group(1))
                url = urljoin(TENUP_BASE, redir_path)
                client.cookies.set("cookietest", "1", domain="tenup.fft.fr")
                await asyncio.sleep(1)
                continue

        m_id = re.search(r'name="form_build_id"[^>]*value="([^"]+)"', html)
        m_tk = re.search(r'"theme_token":"([^"]+)"', html)
        if m_id and m_tk:
            return m_id.group(1), m_tk.group(1)
        await asyncio.sleep(1)

    snippet = html[:300] if html else "No HTML"
    raise RuntimeError(f"TenUp inaccessible. Snippet: {snippet}")


async def fetch_web_ajax(
    cookie_header: str,
    lat: float,
    lng: float,
    rayon_km: int,
    q: str,
    date_start: str,
    date_end: str,
    level: str,
    etype: str,
    max_pages: int = 15,
):
    cookies = parse_cookie_header(cookie_header)
    async with httpx.AsyncClient(headers=WEB_HEADERS, cookies=cookies, timeout=30, follow_redirects=True) as client:
        form_build_id, theme_token = await get_form_state(client)
        payload = {
            "recherche_type": "ville",
            "ville[autocomplete][country]": "fr",
            "ville[autocomplete][textfield]": q,
            "ville[autocomplete][value_container][value_field]": q,
            "ville[autocomplete][value_container][label_field]": q,
            "ville[autocomplete][value_container][lat_field]": str(lat),
            "ville[autocomplete][value_container][lng_field]": str(lng),
            "ville[distance][value_field]": str(rayon_km),
            "pratique": "PADEL",
            "date[start]": format_date_for_tenup(date_start),
            "date[end]": format_date_for_tenup(date_end),
            "sort": "_DIST_",
            "form_id": "recherche_tournois_form",
            "form_build_id": form_build_id,
            "ajax_page_state[theme]": "met",
            "ajax_page_state[theme_token]": theme_token,
            "ajax_page_state[css]": "1",
            "ajax_page_state[js]": "1",
            "op": "Rechercher",
            "submit_main": "Rechercher",
        }
        if level:
            payload[f"categorie_tournoi[{level}]"] = level
        if etype:
            payload[f"epreuve[{etype}]"] = etype

        all_items = []
        seen_ids = set()
        total_from_api = 0
        current_theme_token = theme_token
        
        # Page 0: Initial search with submit_main
        payload["page"] = "0"
        payload["_triggering_element_name"] = "submit_main"
        payload["_triggering_element_value"] = "Rechercher"
        
        print("[TenUp] Fetching page 0...")
        resp = await client.post(TENUP_BASE + AJAX_PATH, data=payload)
        resp.raise_for_status()
        
        try:
            data = resp.json()
            for cmd in data:
                if cmd.get("command") == "settings":
                    current_theme_token = cmd.get("settings", {}).get("ajaxPageState", {}).get("theme_token", current_theme_token)
                if cmd.get("command") == "recherche_tournois_update":
                    results = cmd.get("results", {})
                    total_from_api = results.get("nb_results", 0)
                    for item in results.get("items", []):
                        item_id = item.get("originalId") or item.get("id") or ""
                        if item_id and item_id not in seen_ids:
                            seen_ids.add(item_id)
                            all_items.append(item)
            
            print(f"[TenUp] Page 0: {len(all_items)} items (total: {total_from_api})")
        except Exception as e:
            print(f"[TenUp] Page 0 error: {e}")
        
        # Pagination: Pages 1-N using submit_page
        max_pages = 10
        for page_num in range(1, max_pages):
            if len(seen_ids) >= total_from_api:
                break  # Got all items
            
            payload["ajax_page_state[theme_token]"] = current_theme_token
            payload["page"] = str(page_num)
            payload["_triggering_element_name"] = "submit_page"
            payload["_triggering_element_value"] = "Submit page"
            payload["submit_page"] = "Submit page"
            # Remove submit_main for pagination
            payload.pop("submit_main", None)
            payload.pop("op", None)
            
            try:
                resp = await client.post(TENUP_BASE + AJAX_PATH, data=payload)
                resp.raise_for_status()
                data = resp.json()
                
                before = len(all_items)
                for cmd in data:
                    if cmd.get("command") == "settings":
                        current_theme_token = cmd.get("settings", {}).get("ajaxPageState", {}).get("theme_token", current_theme_token)
                    if cmd.get("command") == "recherche_tournois_update":
                        for item in cmd.get("results", {}).get("items", []):
                            item_id = item.get("originalId") or item.get("id") or ""
                            if item_id and item_id not in seen_ids:
                                seen_ids.add(item_id)
                                all_items.append(item)
                
                new_count = len(all_items) - before
                print(f"[TenUp] Page {page_num}: +{new_count} new")
                
                if new_count == 0:
                    break  # No more new items
                    
            except Exception as e:
                print(f"[TenUp] Page {page_num} error: {e}")
                break
        
        print(f"[TenUp] ✅ Total: {len(all_items)} unique items (API reported: {total_from_api})")
        return {"count": len(all_items), "items": all_items, "source": "tenup_web", "total_api": total_from_api}


@app.get("/api/tenup/search")
async def search_tenup(
    lat: float,
    lng: float,
    rayon_km: int = 100,
    q: str = "",
    date_start: str = "2026-01-15",
    date_end: str = "2026-04-15",
    level: str = "",
    etype: str = "",
):
    # 1. Generate Cache Key
    cache_params = {
        "lat": round(lat, 4), 
        "lng": round(lng, 4), 
        "rayon": rayon_km, 
        "q": q, 
        "ds": date_start, 
        "de": date_end, 
        "lvl": level, 
        "et": etype
    }
    cache_key = "|".join([f"{k}:{v}" for k, v in sorted(cache_params.items())])
    
    # 2. Check Cache
    now = datetime.now().timestamp()
    if cache_key in INTERNAL_CACHE:
        data, expiry = INTERNAL_CACHE[cache_key]
        if now < expiry:
            print(f"[Cache] Hit for {q or f'{lat},{lng}'}")
            return data
        else:
            del INTERNAL_CACHE[cache_key]

    # 3. Cache Eviction (Cleanup old entries if cache gets large)
    if len(INTERNAL_CACHE) > 500:
        keys_to_del = [k for k, (_, exp) in INTERNAL_CACHE.items() if now > exp]
        for k in keys_to_del: del INTERNAL_CACHE[k]

    try:
        result = await _perform_search(lat, lng, rayon_km, q, date_start, date_end, level, etype)
        
        # 4. Save to Cache
        INTERNAL_CACHE[cache_key] = (result, now + CACHE_TTL)
        return result
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")

@app.get("/api/debug")
async def debug_endpoint():
    """Helper to debug Vercel environment"""
    import sys
    
    token = os.environ.get("TENUP_TOKEN")
    token_status = "Missing"
    if token:
        try:
            t = json.loads(token)
            token_status = f"Present (Valid JSON), Access Expires: {t.get('expires_in')}"
        except:
            token_status = "Present (Invalid JSON)"
            
    return {
        "vercel_env": os.environ.get("VERCEL"),
        "python_version": sys.version,
        "tenup_token_status": token_status,
        "cookie_env_len": len(os.environ.get("TENUP_COOKIE") or "") if os.environ.get("TENUP_COOKIE") else 0,
        "data_dir": DATA_DIR,
        "token_path": TOKEN_PATH,
        "token_file_exists": os.path.exists(TOKEN_PATH),
        "files_in_data": os.listdir(DATA_DIR) if os.path.exists(DATA_DIR) else "Dir not found"
    }

async def _perform_search(lat, lng, rayon_km, q, date_start, date_end, level, etype):
    token_data = load_token_file()
    cookie_header = load_cookie_header()

    # Mobile API first
    if token_data and token_data.get("access_token"):
        access_token = token_data.get("access_token")
        refresh_token = token_data.get("refresh_token")
        try:
            items, _raw = await fetch_mobile_api(
                token=access_token,
                lat=lat,
                lng=lng,
                rayon_km=rayon_km,
                date_start=date_start,
                date_end=date_end,
                level=level,
                limit=100,
            )
            return {"count": len(items), "items": items, "source": "mobile_api"}
        except HTTPException as he:
            if he.status_code == 401 and refresh_token:
                try:
                    new_tok = await refresh_access_token(refresh_token)
                    save_token_file(new_tok)
                    items, _raw = await fetch_mobile_api(
                        token=new_tok.get("access_token"),
                        lat=lat,
                        lng=lng,
                        rayon_km=rayon_km,
                        date_start=date_start,
                        date_end=date_end,
                        level=level,
                        limit=100,
                    )
                    return {"count": len(items), "items": items, "source": "mobile_api"}
                except Exception as e:
                    print(f"[Mobile] Refresh failed: {e}")
                    import traceback
                    traceback.print_exc()
                    pass
            # fall through to web if cookie available
        except Exception:
            pass

    if cookie_header:
        try:
            return await fetch_web_ajax(
                cookie_header=cookie_header,
                lat=lat,
                lng=lng,
                rayon_km=rayon_km,
                q=q or "Ville",
                date_start=date_start,
                date_end=date_end,
                level=level,
                etype=etype,
            )
        except Exception as e:
            if "Queue-it redirection detected" in str(e):
                # Cookies expired, try headless refresh
                try:
                    cookie_header = await fetch_cookie_header_via_playwright()
                    return await fetch_web_ajax(
                        cookie_header=cookie_header,
                        lat=lat,
                        lng=lng,
                        rayon_km=rayon_km,
                        q=q or "Ville",
                        date_start=date_start,
                        date_end=date_end,
                        level=level,
                        etype=etype,
                    )
                except Exception as e2:
                    raise HTTPException(status_code=500, detail=f"TenUp web error: {e2}")
            raise HTTPException(status_code=500, detail=f"TenUp web error: {e}")

    # Last resort: headless Playwright to get fresh cookies
    try:
        cookie_header = await fetch_cookie_header_via_playwright()
        return await fetch_web_ajax(
            cookie_header=cookie_header,
            lat=lat,
            lng=lng,
            rayon_km=rayon_km,
            q=q or "Ville",
            date_start=date_start,
            date_end=date_end,
            level=level,
            etype=etype,
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"API mobile indisponible et cookies headless échoués: {e}",
        )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server:app", host="0.0.0.0", port=8001, reload=True)
