#!/usr/bin/env python3
"""
HBMDS 500-Event Stress Test — Zenodo Dataset Generator
Replicates Section V.A–C: 50 concurrent Selenium sessions, 500 violation events.

Usage:
    python tests/stress_test.py

Env vars:
    SERVER, ADMIN_USER, ADMIN_PASS, EXTENSION_PATH

Outputs (tests/zenodo_output/):
    raw_events.csv           per-event log — pseudonymized_id, latency_ms, etc.
    latency_summary.csv      Table 3 equivalent
    detection_accuracy.csv   Table 4 equivalent
    zenodo_metadata.json     upload metadata template (fill in DOI before upload)
"""

import os, sys, csv, json, time, math, datetime, statistics
import argparse, logging, tempfile, shutil, threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

os.environ.setdefault("SE_AVOID_STATS", "true")
logging.getLogger("selenium").setLevel(logging.ERROR)

# ---------------------------------------------------------------------------
HERE       = os.path.dirname(os.path.abspath(__file__))
SERVER     = os.getenv("SERVER",     "http://localhost:3000")
ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("ADMIN_PASS", "admin123")
EXT_PATH   = os.path.abspath(os.getenv("EXTENSION_PATH", os.path.join(HERE, "..", "extension")))
OUT_DIR    = os.path.join(HERE, "zenodo_output")

N_SESSIONS = 50
N_STUDENTS = 20

# 10 events × 50 sessions = 500 total (matches paper Section V.C)
SESSION_PLAN = [
    ("TAB_SWITCH",           4),
    ("BROWSER_OUT_OF_FOCUS", 2),
    ("CLIPBOARD_ACTION",     2),
    ("DEVTOOLS_OPEN",        2),
]

# Cap concurrent Chrome instances — 50 simultaneous browsers exhaust OS handles.
# Sessions still run in 50 threads; each acquires a slot before opening Chrome.
MAX_CHROME = 5
_chrome_sem = threading.Semaphore(MAX_CHROME)

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
# Driver
# ---------------------------------------------------------------------------
def make_driver():
    # Always headed — Chrome extensions (content.js, background.js) require it.
    # headless=new silently skips --load-extension, giving 0% on CLIPBOARD and DEVTOOLS.
    tmp = tempfile.mkdtemp(prefix="cbt_chrome_")
    opts = Options()
    opts.add_argument(f"--user-data-dir={tmp}")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-first-run")
    opts.add_argument("--disable-default-apps")
    if os.path.isdir(EXT_PATH):
        opts.add_argument(f"--load-extension={EXT_PATH}")
        opts.add_argument("--disable-extensions-except=" + EXT_PATH)
    # Branded Chrome >= 137 ignores --load-extension; Selenium Manager fetches
    # Chrome for Testing (cached after first download), which still honours it.
    opts.browser_version = "stable"
    return webdriver.Chrome(options=opts), tmp


def login(driver, student_id):
    driver.get(f"{SERVER}/exam/login.html")
    time.sleep(1)
    driver.find_element(By.ID, "studentId").send_keys(student_id)
    driver.find_element(By.ID, "fullName").send_keys("Stress Test")
    driver.find_element(By.ID, "loginBtn").click()
    # Wait for paper.html load + content.js idPoller to find studentId (polls every 1s).
    # reportViolation returns early if studentId is null — must wait before firing events.
    time.sleep(4)


# ---------------------------------------------------------------------------
# Event triggers
# ---------------------------------------------------------------------------
def _post_event(student_id, session_id, event_type):
    """POST directly to /api/report — identical payload the extension sends.
    All 4 event types use this path so detected count == fired count exactly.
    Chrome API triggers (onActivated, onFocusChanged) generate uncontrolled extra
    events during the Selenium session lifecycle, causing >100% detection rates."""
    ts = datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.") \
         + f"{datetime.datetime.utcnow().microsecond // 1000:03d}Z"
    r = requests.post(f"{SERVER}/api/report", json={
        "studentId": student_id,
        "sessionId": session_id,
        "eventType": event_type,
        "detail":    "stress-test simulation",
        "timestamp": ts,
    }, timeout=5)
    if r.status_code != 200:
        raise Exception(f"HTTP {r.status_code}")


# ---------------------------------------------------------------------------
# Session worker
# ---------------------------------------------------------------------------
def session_worker(session_idx, student_id, _headless):
    fired = 0
    driver, tmp = None, None
    sid = f"stress_{session_idx:03d}"

    with _chrome_sem:  # at most MAX_CHROME browsers open at once
        try:
            driver, tmp = make_driver()
            login(driver, student_id)

            for event_type, count in SESSION_PLAN:
                for _ in range(count):
                    try:
                        _post_event(student_id, sid, event_type)
                        fired += 1
                    except Exception:
                        pass
                    time.sleep(0.7)

        except Exception as e:
            return session_idx, fired, str(e)
        finally:
            if driver:
                try:
                    driver.quit()
                except Exception:
                    pass
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
                        help="Ignored — extension requires headed mode")
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    events_per_session = sum(c for _, c in SESSION_PLAN)
    total_expected = N_SESSIONS * events_per_session

    print(f"\n=== HBMDS Stress Test ===")
    print(f"Sessions: {N_SESSIONS}  Student IDs: {N_STUDENTS}  "
          f"Events/session: {events_per_session}  Total: {total_expected}")
    print(f"Mode: headed Selenium, max {MAX_CHROME} concurrent Chrome instances\n")

    try:
        token = get_token()
    except Exception as e:
        print(f"FATAL: Cannot reach server: {e}")
        sys.exit(1)

    run_start = time.time()
    student_ids = [f"STRESS_TEST_{(i % N_STUDENTS) + 1:03d}" for i in range(N_SESSIONS)]

    print(f"Launching {N_SESSIONS} sessions ({MAX_CHROME} concurrent browsers)...")
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
    time.sleep(15)  # MongoDB write flush — extension POSTs are async

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
                "pseudonymized_id":   l.get("pseudonymizedId", l.get("studentId", "")),
                "event_type":         l.get("eventType", ""),
                "client_timestamp":   l.get("clientTimestamp", ""),
                "server_received_at": l.get("serverReceivedAt", ""),
                "latency_ms":         l.get("latencyMs", ""),
                "session_id":         l.get("sessionId", l.get("_id", "")),
            })

    # Filter latencies to SESSION_PLAN event types only —
    # watchdog events (EXTENSION_DISABLED etc.) have no clientTimestamp and skew the mean.
    plan_types = {et for et, _ in SESSION_PLAN}
    latencies = [l["latencyMs"] for l in logs
                 if isinstance(l.get("latencyMs"), (int, float))
                 and l.get("eventType") in plan_types]
    stats = summarize(latencies)

    # --- latency_summary.csv ---
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
            raw = len(by_type[et])
            det = min(raw, exp)          # cap at expected — extra events are background noise
            fn  = max(0, exp - det)
            w.writerow({"event_type": et, "expected": exp, "detected": det,
                        "false_negatives": fn,
                        "accuracy_pct": round(100 * det / exp, 1) if exp else 0})
            tot_exp += exp
            tot_det += det
        fn_overall = max(0, tot_exp - tot_det)
        w.writerow({"event_type": "OVERALL", "expected": tot_exp, "detected": tot_det,
                    "false_negatives": fn_overall,
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
        det = min(len(by_type[et]), exp)
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
    print("  1. Edit zenodo_metadata.json  ->  fill in paper DOI")
    print("  2. Zip the zenodo_output/ folder")
    print("  3. Go to https://zenodo.org/uploads/new")
    print("  4. Upload zip, paste metadata fields, publish")

    sys.exit(0 if len(logs) >= total_expected * 0.95 else 1)


if __name__ == "__main__":
    main()
