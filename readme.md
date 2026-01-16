# Padel tournament aggregator

This repo starts with TenUp as the first data source.

## TenUp connector

The TenUp API requires authentication. Use your authorized TenUp credentials.

Setup:
- Install dependencies: `pip install -r requirements.txt`
- Create a `.env` file (see `.env.example`) or export:
  - `TENUP_USERNAME`
  - `TENUP_PASSWORD`

Run:
```
python3 scripts/tenup_fetch.py --out data/tenup/tournois.json
```

If you get `unauthorized_client` for the password grant, use the PKCE flow:
```
python3 scripts/tenup_auth.py --out data/tenup/token.json
```
Then set `TENUP_TOKEN` to the `access_token` value from the output and retry:
```
TENUP_TOKEN=... python3 scripts/tenup_fetch.py --out data/tenup/tournois.json
```
Or let the fetch script refresh automatically:
```
TENUP_REFRESH_TOKEN=... python3 scripts/tenup_fetch.py --out data/tenup/tournois.json
```
If you saved `data/tenup/token.json`, the script can reuse it automatically.

Notes:
- Default API base: `https://api.fft.fr/fft/v1/`
- Default endpoint: `competition/tournois`
- Use `--param key=value` to pass query params
- Use `--method POST` to send params as JSON
- Use `--body-file path.json` to send a custom JSON body (for search endpoints)

Security:
- Do not commit credentials. `.env` is ignored by `.gitignore`.


python3 -m http.server 8000
uvicorn server:app --reload --port 8001

