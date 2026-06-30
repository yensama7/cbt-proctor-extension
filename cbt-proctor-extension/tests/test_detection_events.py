#!/usr/bin/env python3
"""
HBMDS Detection Event Verification Test
Triggers each detection event via Selenium and verifies server log records.

Usage:
    pip install selenium requests
    python tests/test_detection_events.py

Environment variables:
    EXTENSION_PATH  — absolute path to the extension/ folder (default: ../extension relative to this file)
    SERVER          — server base URL (default: http://localhost:3000)
    ADMIN_USER      — admin username (default: admin)
    ADMIN_PASS      — admin password (default: admin123)
    STUDENT_ID      — test student ID (default: SELENIUM_TEST_001)
"""

import os
import sys
import time
import datetime
import hashlib
import subprocess
import requests

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.common.action_chains import ActionChains

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------
HERE       = os.path.dirname(os.path.abspath(__file__))
SERVER     = os.getenv("SERVER",     "http://localhost:3000")
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("ADMIN_PASS", "admin123")
STUDENT_ID = os.getenv("STUDENT_ID", "SELENIUM_TEST_001")
EXT_PATH   = os.getenv("EXTENSION_PATH", os.path.join(HERE, "..", "extension"))
EXT_PATH   = os.path.abspath(EXT_PATH)

# SHA-256 hash of student ID (matches server-side pseudonymization)
PSEUDONYMIZED_ID = hashlib.sha256(STUDENT_ID.encode()).hexdigest()

# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------
def get_token():
    r = requests.post(
        f"{SERVER}/api/login",
        json={"username": ADMIN_USER, "password": ADMIN_PASS},
        timeout=5,
    )
    r.raise_for_status()
    return r.json()["token"]


def fetch_recent_logs(token, event_type, since_ts):
    """Return logs of event_type that arrived at server after since_ts (epoch seconds)."""
    r = requests.get(
        f"{SERVER}/api/logs",
        headers={"Authorization": f"Bearer {token}"},
        timeout=5,
    )
    r.raise_for_status()
    logs = r.json()
    found = []
    for l in logs:
        if l.get("eventType") != event_type:
            continue
        srv = l.get("serverReceivedAt", "")
        if not srv:
            continue
        try:
            ts = datetime.datetime.fromisoformat(srv.replace("Z", "+00:00")).timestamp()
            if ts >= since_ts:
                found.append(l)
        except ValueError:
            pass
    return found


def assert_event(token, event_type, since_ts, wait=3):
    """Poll for event_type for up to wait seconds. Return (passed, latency_ms)."""
    deadline = time.time() + wait
    while time.time() < deadline:
        logs = fetch_recent_logs(token, event_type, since_ts)
        if logs:
            latency = logs[0].get("latencyMs")
            return True, latency
        time.sleep(0.5)
    return False, None


def make_driver():
    opts = Options()
    if os.path.isdir(EXT_PATH):
        opts.add_argument(f"--load-extension={EXT_PATH}")
        print(f"  Extension loaded from: {EXT_PATH}")
    else:
        print(f"  WARNING: Extension not found at {EXT_PATH} — extension-detected events may fail")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-extensions-except=" + EXT_PATH)
    return webdriver.Chrome(options=opts)


def login_student(driver):
    driver.get(f"{SERVER}/exam/login.html")
    time.sleep(1)
    driver.find_element(By.ID, "studentId").send_keys(STUDENT_ID)
    driver.find_element(By.ID, "fullName").send_keys("Selenium Test")
    driver.find_element(By.ID, "loginBtn").click()
    time.sleep(2)
    if "paper.html" not in driver.current_url:
        raise RuntimeError(f"Login failed — stuck at {driver.current_url}")
    # Wait for content.js to bootstrap
    time.sleep(3)


# ---------------------------------------------------------------------------
# TEST FUNCTIONS — each returns (event_type, passed, latency_ms)
# ---------------------------------------------------------------------------

def test_tab_switch(driver, token):
    """Open new tab to external URL — background.js TAB_SWITCH via chrome.tabs.onActivated."""
    since = time.time()
    main_handle = driver.current_window_handle
    driver.execute_script("window.open('https://example.com', '_blank');")
    time.sleep(1.5)
    # Switch to the new tab (triggers onActivated for the exam tab being de-focused,
    # then the new external tab being activated)
    new_handle = [h for h in driver.window_handles if h != main_handle][0]
    driver.switch_to.window(new_handle)
    time.sleep(1)
    driver.close()
    driver.switch_to.window(main_handle)
    return assert_event(token, "TAB_SWITCH", since)


def test_unauthorized_navigation(driver, token):
    """Navigate exam tab to external URL — background.js UNAUTHORIZED_NAVIGATION."""
    since = time.time()
    main_handle = driver.current_window_handle
    # Open external URL in a new tab then close — onUpdated fires on the new tab
    driver.execute_script("window.open('https://example.org', '_blank');")
    time.sleep(2)
    new_handle = [h for h in driver.window_handles if h != main_handle][0]
    driver.switch_to.window(new_handle)
    time.sleep(1)
    driver.close()
    driver.switch_to.window(main_handle)
    return assert_event(token, "UNAUTHORIZED_NAVIGATION", since)


def test_browser_out_of_focus(driver, token):
    """Minimise Chrome — background.js BROWSER_OUT_OF_FOCUS via chrome.windows.onFocusChanged."""
    since = time.time()
    try:
        driver.minimize_window()
        time.sleep(1.5)
        driver.maximize_window()
    except Exception:
        # ponytail: ChromeDriver 149 on Windows can't minimize via WebDriver — shell fallback
        subprocess.run(["powershell", "-Command",
            "(New-Object -ComObject Shell.Application).MinimizeAll()"],
            capture_output=True, timeout=3)
        time.sleep(1.5)
        subprocess.run(["powershell", "-Command",
            "(New-Object -ComObject Shell.Application).UndoMinimizeAll()"],
            capture_output=True, timeout=3)
        time.sleep(0.5)
    return assert_event(token, "BROWSER_OUT_OF_FOCUS", since)


def test_window_focus_lost(driver, token):
    """Dispatch synthetic blur on window — content.js WINDOW_FOCUS_LOST."""
    since = time.time()
    driver.execute_script("window.dispatchEvent(new Event('blur'));")
    return assert_event(token, "WINDOW_FOCUS_LOST", since)


def test_tab_hidden(driver, token):
    """Switch to another tab — content.js TAB_HIDDEN via visibilitychange."""
    since = time.time()
    main_handle = driver.current_window_handle
    driver.execute_script("window.open('about:blank', '_blank');")
    time.sleep(0.5)
    new_handle = [h for h in driver.window_handles if h != main_handle][0]
    driver.switch_to.window(new_handle)
    time.sleep(1)
    driver.close()
    driver.switch_to.window(main_handle)
    return assert_event(token, "TAB_HIDDEN", since)


def test_clipboard_action(driver, token):
    """Ctrl+A then trigger copy event — content.js CLIPBOARD_ACTION."""
    since = time.time()
    body = driver.find_element(By.TAG_NAME, "body")
    body.click()
    # Use execCommand to fire a real copy DOM event (JS clipboard event listeners catch this)
    driver.execute_script("document.dispatchEvent(new ClipboardEvent('copy'));")
    return assert_event(token, "CLIPBOARD_ACTION", since)


def test_devtools_open(driver, token):
    """Press F12 — content.js DEVTOOLS_OPEN."""
    since = time.time()
    body = driver.find_element(By.TAG_NAME, "body")
    body.click()
    body.send_keys(Keys.F12)
    return assert_event(token, "DEVTOOLS_OPEN", since)


def test_right_click(driver, token):
    """Right-click on exam page — content.js RIGHT_CLICK."""
    since = time.time()
    body = driver.find_element(By.TAG_NAME, "body")
    ActionChains(driver).context_click(body).perform()
    return assert_event(token, "RIGHT_CLICK", since)


def test_suspicious_resize(driver, token):
    """Shrink window by >150px — content.js SUSPICIOUS_RESIZE."""
    since = time.time()
    size = driver.get_window_size()
    driver.set_window_size(size["width"] - 200, size["height"] - 200)
    time.sleep(0.5)
    driver.set_window_size(size["width"], size["height"])
    return assert_event(token, "SUSPICIOUS_RESIZE", since)


def test_restricted_key(driver, token):
    """Press Ctrl+U (View Source) — content.js RESTRICTED_KEY."""
    since = time.time()
    body = driver.find_element(By.TAG_NAME, "body")
    body.click()
    ActionChains(driver).key_down(Keys.CONTROL).send_keys("u").key_up(Keys.CONTROL).perform()
    return assert_event(token, "RESTRICTED_KEY", since)


def test_page_unload(driver, token):
    """Dispatch synthetic pagehide — content.js PAGE_UNLOAD."""
    since = time.time()
    driver.execute_script("window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));")
    return assert_event(token, "PAGE_UNLOAD", since)


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------
TESTS = [
    ("TAB_SWITCH",           test_tab_switch),
    ("UNAUTHORIZED_NAV",     test_unauthorized_navigation),
    ("BROWSER_OUT_OF_FOCUS", test_browser_out_of_focus),
    ("WINDOW_FOCUS_LOST",    test_window_focus_lost),
    ("TAB_HIDDEN",           test_tab_hidden),
    ("CLIPBOARD_ACTION",     test_clipboard_action),
    ("DEVTOOLS_OPEN",        test_devtools_open),
    ("RIGHT_CLICK",          test_right_click),
    ("SUSPICIOUS_RESIZE",    test_suspicious_resize),
    ("RESTRICTED_KEY",       test_restricted_key),
    ("PAGE_UNLOAD",          test_page_unload),
]


def main():
    print(f"\n=== HBMDS Detection Event Verification ===")
    print(f"Server:      {SERVER}")
    print(f"Student ID:  {STUDENT_ID}")
    print(f"Hash:        {PSEUDONYMIZED_ID[:16]}...")
    print(f"Extension:   {EXT_PATH}\n")

    # Verify server is up
    try:
        token = get_token()
        print(f"Admin auth: OK\n")
    except Exception as e:
        print(f"FATAL: Cannot reach server or login: {e}")
        sys.exit(1)

    driver = make_driver()
    results = {}

    try:
        login_student(driver)
        print(f"Student session started. Running {len(TESTS)} detection tests...\n")

        for name, fn in TESTS:
            print(f"  [{name}]", end=" ", flush=True)
            try:
                passed, latency = fn(driver, token)
                tag = "PASS" if passed else "FAIL"
                lat = f"  latency={latency}ms" if latency is not None else ""
                results[name] = {"passed": passed, "latency": latency}
                print(f"{tag}{lat}")
            except Exception as e:
                results[name] = {"passed": False, "latency": None, "error": str(e)}
                print(f"ERROR: {e}")

    finally:
        driver.quit()

    # Summary
    print("\n=== Summary ===")
    passed  = sum(1 for r in results.values() if r["passed"])
    total   = len(results)
    lats    = [r["latency"] for r in results.values() if r["latency"] is not None]
    avg_lat = int(sum(lats) / len(lats)) if lats else None

    for name, r in results.items():
        status = "PASS" if r["passed"] else "FAIL"
        lat    = f"  ({r['latency']}ms)" if r.get("latency") is not None else ""
        err    = f"  [{r['error']}]" if r.get("error") else ""
        print(f"  [{status}] {name}{lat}{err}")

    print(f"\nDetection rate: {passed}/{total} ({100*passed//total}%)")
    if avg_lat is not None:
        print(f"Mean latency:   {avg_lat}ms  (paper spec: 450ms +/- 50ms over Wi-Fi)")

    sys.exit(0 if passed == total else 1)


if __name__ == "__main__":
    main()
