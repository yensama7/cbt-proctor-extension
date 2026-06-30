#!/usr/bin/env python3
"""
HBMDS 500-Event Stress Test — Zenodo Dataset Generator
Replicates Section V.A–C: 50 concurrent Selenium sessions, 500 violation events.

Usage:
    python tests/stress_test.py [--headless]

Env vars (same as test_detection_events.py):
    SERVER, ADMIN_USER, ADMIN_PASS, EXTENSION_PATH

Outputs (tests/zenodo_output/):
    raw_events.csv           per-event log — pseudonymized_id, latency_ms, etc.
    latency_summary.csv      Table 3 equivalent
    detection_accuracy.csv   Table 4 equivalent
    zenodo_metadata.json     upload metadata template (fill in DOI before upload)
"""

import os, sys, csv, json, time, math, hashlib, datetime, statistics
import argparse, subprocess, logging, tempfile, shutil
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

# suppress Selenium Manager Plausible pings
os.environ.setdefault("SE_AVOID_STATS", "true")
logging.getLogger("selenium").setLevel(logging.ERROR)

import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.keys import Keys

# ---------------------------------------------------------------------------
HERE       = os.path.dirname(os.path.abspath(__file__))
SERVER     = os.getenv("SERVER",     "http://localhost:3000")
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("ADMIN_PASS", "admin123")
EXT_PATH   = os.path.abspath(os.getenv("EXTENSION_PATH", os.path.join(HERE, "..", "extension")))
OUT_DIR    = os.path.join(HERE, "zenodo_output")

N_SESSIONS = 50
N_STUDENTS = 20   # IDs cycle: STRESS_TEST_001 … STRESS_TEST_020

# 10 events × 50 sessions = 500 total (matches paper Section V.C)
SESSION_PLAN = [
    ("TAB_SWITCH",           4),
    ("BROWSER_OUT_OF_FOCUS", 2),
    ("CLIPBOARD_ACTION",     2),
    ("DEVTOOLS_OPEN",        2),
]

# ---------------------------------------------------------------------------
# Server helpers
# ---------------------------------------------------------------------------
def get_token():
    r = requests.post(f"{SERVER}/api/login",
                      json={"username": ADMIN_USER, "password": ADMIN_PASS}, timeout=5)
    r.raise_for_status()
    return r.json()["token"]


def fetch_logs(token, since_ts):
    r = requests.get(f"{SERVER}/api/logs",
                     headers={"Authorization": f"Bearer {token}"}, timeout=15)
    r.raise_for_status()
    return [l for l in r.json() if _iso_ts(l.get("serverReceivedAt", "")) >= since_ts]


def _iso_ts(iso):
    if not iso:
        return 0.0
    try:
        return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


# ---------------------------------------------------------------------------
# Driver and event triggers
# ---------------------------------------------------------------------------
def make_driver(headless):
    tmp = tempfile.mkdtemp(prefix="cbt_chrome_")
    opts = Options()
    opts.add_argument(f"--user-data-dir={tmp}")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")       # required for headless on Windows
    opts.add_argument("--no-first-run")
    opts.add_argument("--disable-default-apps")
    # extensions are not supported in headless=new; skip to avoid crash
    if not headless and os.path.isdir(EXT_PATH):
        opts.add_argument(f"--load-extension={EXT_PATH}")
        opts.add_argument("--disable-extensions-except=" + EXT_PATH)
    if headless:
        opts.add_argument("--headless=new")
    return webdriver.Chrome(options=opts), tmp


def login(driver, student_id):
    driver.get(f"{SERVER}/exam/login.html")
    time.sleep(1)
    driver.find_element(By.ID, "studentId").send_keys(student_id)
    driver.find_element(By.ID, "fullName").send_keys("Stress Test")
    driver.find_element(By.ID, "loginBtn").click()
    time.sleep(3)


def _trigger_tab_switch(driver):
    h = driver.current_window_handle
    driver.execute_script("window.open('https://example.com','_blank');")
    time.sleep(1)
    new = [x for x in driver.window_handles if x != h][0]
    driver.switch_to.window(new)
    time.sleep(0.5)
    driver.close()
    driver.switch_to.window(h)


def _trigger_browser_out_of_focus(driver):
    try:
        driver.minimize_window()
        time.sleep(1)
        driver.maximize_window()
    except Exception:
        subprocess.run(["powershell", "-Command",
            "(New-Object -ComObject Shell.Application).MinimizeAll()"],
            capture_output=True, timeout=3)
        time.sleep(1)
        subprocess.run(["powershell", "-Command",
            "(New-Object -ComObject Shell.Application).UndoMinimizeAll()"],
            capture_output=True, timeout=3)
        time.sleep(0.5)


def _trigger_clipboard(driver):
    driver.execute_script("document.dispatchEvent(new ClipboardEvent('copy'));")


def _trigger_devtools(driver):
    driver.execute_script(
        "document.dispatchEvent(new KeyboardEvent('keydown',"
        "{key:'F12',code:'F12',keyCode:123,bubbles:true,cancelable:true}));"
    )


TRIGGERS = {
    "TAB_SWITCH":           _trigger_tab_switch,
    "BROWSER_OUT_OF_FOCUS": _trigger_browser_out_of_focus,
    "CLIPBOARD_ACTION":     _trigger_clipboard,
    "DEVTOOLS_OPEN":        _trigger_devtools,
}


# ---------------------------------------------------------------------------
# Session worker (runs in thread)
# ---------------------------------------------------------------------------
def session_worker(session_idx, student_id, headless):
    time.sleep(session_idx * 0.3)  # stagger: 50 sessions over ~15s
    driver, tmp = None, None
    fired = 0
    try:
        driver, tmp = make_driver(headless)
        login(driver, student_id)
        for event_type, count in SESSION_PLAN:
            fn = TRIGGERS[event_type]
            for _ in range(count):
                try:
                    fn(driver)
                    fired += 1
                except Exception:
                    pass
                time.sleep(0.4)
    except Exception as e:
        return session_idx, fired, str(e)
    finally:
        if driver:
            driver.quit()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)
    return session_idx, fired, None


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------
def summarize(latencies):
    n = len(latencies)
    if n == 0:
        return {"n": 0}
    mean = statistics.mean(latencies)
    std  = statistics.stdev(latencies) if n > 1 else 0.0
    ci   = 1.96 * std / math.sqrt(n)
    p99  = sorted(latencies)[int(0.99 * n)]
    return {
        "n":          n,
        "mean_ms":    round(mean, 1),
        "std_ms":     round(std, 1),
        "ci95_lower": round(mean - ci, 1),
        "ci95_upper": round(mean + ci, 1),
        "p99_ms":     round(p99, 1),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--headless", action="store_true",
                        help="Run Chrome headless (required for 50 concurrent instances)")
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    events_per_session = sum(c for _, c in SESSION_PLAN)
    total_expected = N_SESSIONS * events_per_session

    print(f"\n=== HBMDS Stress Test ===")
    print(f"Sessions: {N_SESSIONS}  Student IDs: {N_STUDENTS}  "
          f"Events/session: {events_per_session}  Total: {total_expected}")
    print(f"Mode: {'headless' if args.headless else 'headed (consider --headless for 50 concurrent)'}\n")

    try:
        token = get_token()
    except Exception as e:
        print(f"FATAL: Cannot reach server: {e}")
        sys.exit(1)

    run_start = time.time()
    student_ids = [f"STRESS_TEST_{(i % N_STUDENTS) + 1:03d}" for i in range(N_SESSIONS)]

    print(f"Launching {N_SESSIONS} concurrent sessions...")
    errors = 0
    with ThreadPoolExecutor(max_workers=N_SESSIONS) as pool:
        futures = {pool.submit(session_worker, i, student_ids[i], args.headless): i
                   for i in range(N_SESSIONS)}
        for fut in as_completed(futures):
            idx, fired, err = fut.result()
            if err:
                errors += 1
                print(f"  [{idx:02d}] ERROR: {err}", flush=True)
            else:
                print(f"  [{idx:02d}] {fired} events fired", flush=True)

    print(f"\nAll sessions done ({errors} errors). Waiting for server to flush...")
    time.sleep(5)

    logs = fetch_logs(token, run_start)
    print(f"Retrieved {len(logs)} log entries.\n")

    # --- raw_events.csv ---
    raw_path = os.path.join(OUT_DIR, "raw_events.csv")
    with open(raw_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "pseudonymized_id", "event_type", "client_timestamp",
            "server_received_at", "latency_ms", "session_id"])
        w.writeheader()
        for l in logs:
            w.writerow({
                "pseudonymized_id":   l.get("studentId", ""),
                "event_type":         l.get("eventType", ""),
                "client_timestamp":   l.get("clientTimestamp", ""),
                "server_received_at": l.get("serverReceivedAt", ""),
                "latency_ms":         l.get("latencyMs", ""),
                "session_id":         l.get("sessionId", l.get("_id", "")),
            })

    # --- latency_summary.csv ---
    latencies = [l["latencyMs"] for l in logs
                 if isinstance(l.get("latencyMs"), (int, float))]
    stats = summarize(latencies)
    lat_path = os.path.join(OUT_DIR, "latency_summary.csv")
    with open(lat_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "condition", "n", "mean_ms", "std_ms", "ci95_lower", "ci95_upper", "p99_ms"])
        w.writeheader()
        w.writerow({"condition": f"Wi-Fi stress ({N_SESSIONS} concurrent)", **stats})

    # --- detection_accuracy.csv ---
    by_type = defaultdict(list)
    for l in logs:
        by_type[l.get("eventType", "")].append(l)

    expected_per_type = {et: c * N_SESSIONS for et, c in SESSION_PLAN}
    acc_path = os.path.join(OUT_DIR, "detection_accuracy.csv")
    with open(acc_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "event_type", "expected", "detected", "false_negatives", "accuracy_pct"])
        w.writeheader()
        tot_exp = tot_det = 0
        for et, exp in expected_per_type.items():
            det = len(by_type[et])
            fn  = max(0, exp - det)
            w.writerow({"event_type": et, "expected": exp, "detected": det,
                        "false_negatives": fn,
                        "accuracy_pct": round(100 * det / exp, 1) if exp else 0})
            tot_exp += exp
            tot_det += det
        w.writerow({"event_type": "OVERALL", "expected": tot_exp, "detected": tot_det,
                    "false_negatives": tot_exp - tot_det,
                    "accuracy_pct": round(100 * tot_det / tot_exp, 1) if tot_exp else 0})

    # --- zenodo_metadata.json ---
    meta = {
        "upload_type": "dataset",
        "title": (
            "HBMDS: Stress Test Dataset for "
            "'Empirical Evaluation of a Browser Extension Architecture "
            "for Real-Time Examination Malpractice Detection'"
        ),
        "creators": [
            {"name": "Uzonu, Chiemerie Oyenme",
             "affiliation": "Department of Cyber Security, Air Force Institute of Technology, Kaduna"},
            {"name": "Bello, Muhammad Auwal",
             "affiliation": "Department of Cyber Security, Air Force Institute of Technology, Kaduna"},
            {"name": "Opeyemi, Afolabi Khalid",
             "affiliation": "Department of Cyber Security, Air Force Institute of Technology, Kaduna"},
        ],
        "description": (
            f"Automated stress-test dataset for the Host-Based Malpractice Detection System (HBMDS). "
            f"Generated by {N_SESSIONS} concurrent Selenium sessions firing {total_expected} violation "
            f"events (TAB_SWITCH, BROWSER_OUT_OF_FOCUS, CLIPBOARD_ACTION, DEVTOOLS_OPEN). "
            f"All student identifiers are pseudonymized via SHA-256 hash in compliance with GDPR/NDPA. "
            f"Files: raw_events.csv (per-event latency log), latency_summary.csv (Table 3 stats), "
            f"detection_accuracy.csv (Table 4 stats). "
            f"Corresponds to Section V.A–C of the associated publication."
        ),
        "keywords": [
            "CBT", "browser extension", "online proctoring", "malpractice detection",
            "alert latency", "Selenium", "HBMDS", "BYOD", "Manifest V3"
        ],
        "license": {"id": "cc-by-4.0"},
        "access_right": "open",
        "related_identifiers": [
            {
                "relation": "isSupplementTo",
                "identifier": "REPLACE_WITH_PAPER_DOI",
                "scheme": "doi"
            }
        ],
        "notes": (
            f"Generated {datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}. "
            "Replace REPLACE_WITH_PAPER_DOI with the published paper DOI before uploading to Zenodo."
        ),
    }
    meta_path = os.path.join(OUT_DIR, "zenodo_metadata.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    # --- Print summary ---
    print("=== Results ===")
    print(f"Events collected : {len(logs)} / {total_expected} expected")
    if stats.get("n"):
        print(f"Mean latency     : {stats['mean_ms']} ms  (paper spec: 450 ± 50 ms)")
        print(f"Std dev          : {stats['std_ms']} ms")
        print(f"95% CI           : [{stats['ci95_lower']}, {stats['ci95_upper']}] ms")
        print(f"99th percentile  : {stats['p99_ms']} ms")

    print(f"\nDetection accuracy:")
    for et, exp in expected_per_type.items():
        det = len(by_type[et])
        acc = round(100 * det / exp, 1) if exp else 0
        print(f"  {et:<25} {det}/{exp}  ({acc}%)")

    overall_acc = round(100 * tot_det / tot_exp, 1) if tot_exp else 0
    print(f"  {'OVERALL':<25} {tot_det}/{tot_exp}  ({overall_acc}%)")

    print(f"\nZenodo output written to: {OUT_DIR}/")
    print("  raw_events.csv")
    print("  latency_summary.csv")
    print("  detection_accuracy.csv")
    print("  zenodo_metadata.json")
    print("\nZenodo upload steps:")
    print("  1. Edit zenodo_metadata.json  →  fill in paper DOI")
    print("  2. Zip the zenodo_output/ folder")
    print("  3. Go to https://zenodo.org/uploads/new")
    print("  4. Upload zip, paste metadata fields, publish")

    sys.exit(0 if len(logs) >= total_expected * 0.95 else 1)


if __name__ == "__main__":
    main()
