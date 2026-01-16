#!/usr/bin/env python3
import argparse
import json
import os
import sys
from datetime import datetime

try:
    import requests
except ImportError:  # pragma: no cover - runtime guard
    sys.stderr.write("Missing dependency: requests. Install with: pip install -r requirements.txt\n")
    sys.exit(1)

DEFAULT_TOKEN_URL = "https://login.fft.fr/realms/connect/protocol/openid-connect/token"
DEFAULT_API_BASE = "https://api.fft.fr/fft/v1/"
DEFAULT_CLIENT_ID = "tenup-app"
DEFAULT_SCOPE = "openid"


def load_env_file(path):
    env = {}
    if not path or not os.path.exists(path):
        return env
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (
                value.startswith("'") and value.endswith("'")
            ):
                value = value[1:-1]
            if key:
                env[key] = value
    return env


def env_get(key, env_file_vars):
    return os.environ.get(key) or env_file_vars.get(key)


def parse_params(items):
    params = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"Invalid --param '{item}', expected key=value")
        key, value = item.split("=", 1)
        params[key] = value
    return params


def fetch_token(session, token_url, client_id, username, password, scope, debug=False):
    data = {
        "grant_type": "password",
        "client_id": client_id,
        "username": username,
        "password": password,
        "scope": scope,
    }
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-APPLICATION-ID": client_id,
    }
    resp = session.post(token_url, data=data, headers=headers, timeout=30)
    if debug:
        sys.stderr.write(f"[tenup] token status={resp.status_code}\n")
    if resp.status_code != 200:
        try:
            err = resp.json()
        except Exception:
            err = {"error": resp.text[:500]}
        if isinstance(err, dict) and err.get("error") == "unauthorized_client":
            raise RuntimeError(
                "Token request failed: client disallows password grant. "
                "Use scripts/tenup_auth.py to get a token via authorization_code."
            )
        raise RuntimeError(f"Token request failed: {err}")
    return resp.json()


def refresh_access_token(session, token_url, client_id, refresh_token, debug=False):
    data = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
    }
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-APPLICATION-ID": client_id,
    }
    resp = session.post(token_url, data=data, headers=headers, timeout=30)
    if debug:
        sys.stderr.write(f"[tenup] refresh status={resp.status_code}\n")
    if resp.status_code != 200:
        try:
            err = resp.json()
        except Exception:
            err = {"error": resp.text[:500]}
        raise RuntimeError(f"Refresh token request failed: {err}")
    return resp.json()


def request_api(session, method, url, token, client_id, params, body, debug=False):
    headers = {
        "Authorization": f"Bearer {token}",
        "X-APPLICATION-ID": client_id,
        "Accept": "application/json",
    }
    if method == "GET":
        resp = session.get(url, params=params, headers=headers, timeout=30)
    elif method == "POST":
        headers["Content-Type"] = "application/json"
        resp = session.post(url, json=body, headers=headers, timeout=30)
    else:
        raise ValueError(f"Unsupported method: {method}")
    if debug:
        sys.stderr.write(f"[tenup] api status={resp.status_code} url={resp.url}\n")
    return resp


def write_output(path, payload):
    if path == "-":
        json.dump(payload, sys.stdout, ensure_ascii=True, indent=2)
        sys.stdout.write("\n")
        return
    dir_name = os.path.dirname(path)
    if dir_name:
        os.makedirs(dir_name, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2)


def main():
    parser = argparse.ArgumentParser(
        description="Fetch TenUp tournaments via the FFT API"
    )
    parser.add_argument("--env-file", default=".env", help="Optional env file path")
    parser.add_argument("--username-env", default="TENUP_USERNAME")
    parser.add_argument("--password-env", default="TENUP_PASSWORD")
    parser.add_argument("--token-url", default=DEFAULT_TOKEN_URL)
    parser.add_argument("--client-id", default=DEFAULT_CLIENT_ID)
    parser.add_argument("--scope", default=DEFAULT_SCOPE)
    parser.add_argument("--api-base", default=DEFAULT_API_BASE)
    parser.add_argument("--endpoint", default="competition/tournois")
    parser.add_argument("--method", default="GET")
    parser.add_argument("--param", action="append", default=[], help="Query param key=value")
    parser.add_argument(
        "--body-file",
        default="",
        help="Path to JSON file used as POST body",
    )
    parser.add_argument(
        "--body-json",
        default="",
        help="Inline JSON string used as POST body",
    )
    parser.add_argument(
        "--token-file",
        default="data/tenup/token.json",
        help="Optional JSON file with access_token/refresh_token",
    )
    parser.add_argument(
        "--out", default="data/tenup/tournois.json", help="Output path or '-'"
    )
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    env_file_vars = load_env_file(args.env_file)

    client_id = env_get("TENUP_CLIENT_ID", env_file_vars) or args.client_id
    token_url = env_get("TENUP_TOKEN_URL", env_file_vars) or args.token_url
    scope = env_get("TENUP_SCOPE", env_file_vars) or args.scope
    api_base = env_get("TENUP_API_BASE", env_file_vars) or args.api_base

    token = env_get("TENUP_TOKEN", env_file_vars)
    refresh_token = env_get("TENUP_REFRESH_TOKEN", env_file_vars)
    token_file = env_get("TENUP_TOKEN_FILE", env_file_vars) or args.token_file

    if not token and not refresh_token and token_file and os.path.exists(token_file):
        try:
            with open(token_file, "r", encoding="utf-8") as handle:
                token_data = json.load(handle)
            token = token_data.get("access_token")
            refresh_token = token_data.get("refresh_token") or refresh_token
        except Exception:
            pass

    session = requests.Session()
    if refresh_token:
        token_data = refresh_access_token(
            session,
            token_url=token_url,
            client_id=client_id,
            refresh_token=refresh_token,
            debug=args.debug,
        )
        token = token_data.get("access_token")
    elif not token:
        username = env_get(args.username_env, env_file_vars)
        password = env_get(args.password_env, env_file_vars)
        if not username or not password:
            sys.stderr.write(
                "Missing credentials. Set TENUP_TOKEN/TENUP_REFRESH_TOKEN or TENUP_USERNAME/TENUP_PASSWORD.\n"
            )
            sys.exit(2)
        token_data = fetch_token(
            session,
            token_url=token_url,
            client_id=client_id,
            username=username,
            password=password,
            scope=scope,
            debug=args.debug,
        )
        token = token_data.get("access_token")

    if not token:
        sys.stderr.write("Token response missing access_token.\n")
        sys.exit(2)

    method = args.method.strip().upper()
    params = parse_params(args.param)
    body = None
    if args.body_json:
        body = json.loads(args.body_json)
    elif args.body_file:
        if os.path.exists(args.body_file):
            with open(args.body_file, "r", encoding="utf-8") as handle:
                body = json.load(handle)
        else:
            sys.stderr.write(f"Body file not found: {args.body_file}\n")
            sys.exit(2)
    url = api_base.rstrip("/") + "/" + args.endpoint.lstrip("/")

    resp = request_api(
        session,
        method=method,
        url=url,
        token=token,
        client_id=client_id,
        params=params,
        body=body,
        debug=args.debug,
    )

    try:
        payload = resp.json()
    except Exception:
        payload = {"raw": resp.text}

    if not resp.ok:
        sys.stderr.write(
            f"API request failed: status={resp.status_code} url={resp.url}\n"
        )
        write_output(args.out, payload)
        sys.exit(1)

    write_output(args.out, payload)
    if args.debug:
        sys.stderr.write(
            f"[tenup] wrote {args.out} at {datetime.utcnow().isoformat()}Z\n"
        )


if __name__ == "__main__":
    main()
