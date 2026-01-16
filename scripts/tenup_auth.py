#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
import sys
from urllib.parse import parse_qs, urlencode, urlparse

try:
    import requests
except ImportError:  # pragma: no cover - runtime guard
    sys.stderr.write("Missing dependency: requests. Install with: pip install -r requirements.txt\n")
    sys.exit(1)

DEFAULT_AUTH_URL = "https://login.fft.fr/realms/connect/protocol/openid-connect/auth"
DEFAULT_TOKEN_URL = "https://login.fft.fr/realms/connect/protocol/openid-connect/token"
DEFAULT_CLIENT_ID = "tenup-app"
DEFAULT_SCOPE = "openid"
# Redirect URI observed in the TenUp APK deep links.
DEFAULT_REDIRECT_URI = "mat://auth_callback"


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def build_pkce():
    verifier = b64url(os.urandom(32))
    challenge = b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def prompt_redirect_url():
    sys.stdout.write("\nPaste the full redirected URL here:\n> ")
    sys.stdout.flush()
    return sys.stdin.readline().strip()


def parse_code_from_url(redirect_url):
    parsed = urlparse(redirect_url)
    params = parse_qs(parsed.query)
    code = params.get("code", [None])[0]
    if not code:
        # Some flows send the code in fragment.
        params = parse_qs(parsed.fragment)
        code = params.get("code", [None])[0]
    return code


def exchange_code(token_url, client_id, code, redirect_uri, verifier, scope, debug=False):
    data = {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
        "scope": scope,
    }
    headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-APPLICATION-ID": client_id,
    }
    resp = requests.post(token_url, data=data, headers=headers, timeout=30)
    if debug:
        sys.stderr.write(f"[tenup] token status={resp.status_code}\n")
    if resp.status_code != 200:
        try:
            err = resp.json()
        except Exception:
            err = {"error": resp.text[:500]}
        raise RuntimeError(f"Token request failed: {err}")
    return resp.json()


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
        description="Get a TenUp access token using the authorization_code + PKCE flow"
    )
    parser.add_argument("--client-id", default=DEFAULT_CLIENT_ID)
    parser.add_argument("--scope", default=DEFAULT_SCOPE)
    parser.add_argument("--auth-url", default=DEFAULT_AUTH_URL)
    parser.add_argument("--token-url", default=DEFAULT_TOKEN_URL)
    parser.add_argument("--redirect-uri", default=DEFAULT_REDIRECT_URI)
    parser.add_argument("--out", default="data/tenup/token.json")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    verifier, challenge = build_pkce()
    auth_params = {
        "client_id": args.client_id,
        "response_type": "code",
        "redirect_uri": args.redirect_uri,
        "scope": args.scope,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    }
    auth_url = args.auth_url + "?" + urlencode(auth_params)

    sys.stdout.write("Open this URL in your browser and log in:\n")
    sys.stdout.write(auth_url + "\n")
    sys.stdout.flush()

    redirect_url = prompt_redirect_url()
    code = parse_code_from_url(redirect_url)
    if not code:
        sys.stderr.write("No code found in redirected URL.\n")
        sys.exit(2)

    token_data = exchange_code(
        token_url=args.token_url,
        client_id=args.client_id,
        code=code,
        redirect_uri=args.redirect_uri,
        verifier=verifier,
        scope=args.scope,
        debug=args.debug,
    )
    write_output(args.out, token_data)
    sys.stdout.write(
        f"Token saved to {args.out}. You can set TENUP_TOKEN from access_token.\n"
    )


if __name__ == "__main__":
    main()
