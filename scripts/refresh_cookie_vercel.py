import asyncio
import os
import sys

async def refresh_cookie():
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print("❌ Playwright is not installed. Please run: pip install playwright")
        return

    TENUP_BASE = "https://tenup.fft.fr"
    # We go to search page to trigger Queue-it
    URL = f"{TENUP_BASE}/recherche/tournois"
    
    print(f"🌐 Lancement de Playwright pour récupérer le cookie Ten'Up...")
    print(f"🔗 Navigation vers {URL}...")

    async with async_playwright() as p:
        # Launch browser
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()
        
        try:
            # Go to TenUp
            await page.goto(URL, wait_until="networkidle", timeout=60000)
            # Wait a bit for Queue-it to settle
            await page.wait_for_timeout(3000)
            
            cookies = await context.cookies()
            await browser.close()
            
            # Filter for tenup.fft.fr cookies
            tenup_cookies = [c for c in cookies if "tenup.fft.fr" in c.get("domain", "")]
            if not tenup_cookies:
                tenup_cookies = cookies
            
            cookie_str = "; ".join([f"{c['name']}={c['value']}" for c in tenup_cookies])
            
            if "QueueITAccepted" not in cookie_str:
                print("⚠️  Avertissement : Le cookie QueueITAccepted n'a pas été trouvé.")
                print("Le refresh a peut-être échoué ou l'anti-bot n'était pas actif.")
            
            print("\n" + "="*60)
            print("✅ COOKIE GÉNÉRÉ AVEC SUCCÈS")
            print("="*60)
            print("\nCopie cette valeur dans ta variable d'environnement TENUP_COOKIE sur Vercel :\n")
            print(cookie_str)
            print("\n" + "="*60)
            
            # Optionally update local data/tenup/cookies.txt
            save_path = "data/tenup/cookies.txt"
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            with open(save_path, "w", encoding="utf-8") as f:
                f.write(cookie_str)
            print(f"💾 Sauvegardé localement dans {save_path}")

        except Exception as e:
            print(f"❌ Erreur lors du refresh : {e}")
            if 'browser' in locals():
                await browser.close()

if __name__ == "__main__":
    asyncio.run(refresh_cookie())
