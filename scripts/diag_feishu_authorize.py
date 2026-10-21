# -*- coding: utf-8 -*-
"""诊断飞书 OAuth 授权页在 iframe 场景的真实表现（无会话 vs 有会话）。"""
import json, sys, time
from playwright.sync_api import sync_playwright

APP_ID = "cli_aa52b3d3217b9bfe"
REDIRECT = "https://hr-work.club/api/feishu/oauth/callback"
AUTH_URL = (
    f"https://accounts.feishu.cn/open-apis/authen/v1/authorize"
    f"?client_id={APP_ID}&response_type=code&redirect_uri={REDIRECT}"
    f"&state=diag&prompt=consent"
)

reqs = []

def on_response(resp):
    u = resp.url
    if "feishu" not in u:
        return
    body = ""
    try:
        if any(k in u for k in ("qr", "login", "authorize", "passport")):
            body = resp.text()[:600]
    except Exception:
        pass
    reqs.append({"m": resp.request.method, "url": u[:220], "st": resp.status, "body": body})

with sync_playwright() as p:
    b = p.chromium.launch(
        headless=True,
        executable_path="C:/Users/mi/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe",
        args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    )
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, locale="zh-CN")
    pg = ctx.new_page()
    pg.on("response", on_response)
    try:
        pg.goto(AUTH_URL, wait_until="domcontentloaded", timeout=30000)
    except Exception as e:
        print("goto err:", e)
    time.sleep(6)
    print("=== FINAL URL ===")
    print(pg.url)
    print("=== VISIBLE TEXT (first 1500) ===")
    try:
        print(pg.inner_text("body")[:1500])
    except Exception as e:
        print("text err:", e)
    pg.screenshot(path="diag_authorize.png", full_page=False)
    print("=== REQS ===")
    for r in reqs:
        print(r["st"], r["m"], r["url"])
        if r["body"]:
            print("   body:", r["body"][:400].replace("\n", " "))
    b.close()
