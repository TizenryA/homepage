#!/usr/bin/env python3
"""Build the public monitor snapshot for 渡鸦の小站.

The homepage is hosted on GitHub Pages, so it reads this same-origin JSON file
instead of calling NewAPI directly from the browser. The snapshot intentionally
contains only public aggregate data: no users, tokens, channel IDs, logs, or
balances.
"""
from __future__ import annotations

import json
import math
import os
import re
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE_URL = os.environ.get("RAVEN_API_BASE", "https://tizenry.xyz").rstrip("/")
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "monitor.json"
TIMEOUT = int(os.environ.get("RAVEN_MONITOR_TIMEOUT", "20"))
UA = "RavenHomepageMonitor/1.0 (+https://tizenrya.github.io/homepage/)"
VOLATILE_KEYS = {"updated_at", "updated_at_unix"}


def fetch_json(path: str) -> dict[str, Any]:
    req = Request(
        BASE_URL + path,
        headers={
            "User-Agent": UA,
            "Accept": "application/json",
        },
    )
    with urlopen(req, timeout=TIMEOUT) as resp:
        body = resp.read().decode("utf-8", "replace")
    return json.loads(body)


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        if math.isfinite(number):
            return number
    except (TypeError, ValueError):
        pass
    return default


def public_model_name(name: Any) -> str:
    text = str(name or "").strip()
    # Hide obvious upstream/channel labels while keeping the model name useful.
    text = re.sub(r"^\[[^\]]+\]\s*", "", text)
    if "/" in text:
        prefix, rest = text.split("/", 1)
        if "渠道" in prefix or prefix.lower() in {"team", "internal"}:
            text = rest
    text = re.sub(r"-console$", "", text)
    return text or "未命名模型"


def unique_keep_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        key = value.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result


def build_core() -> dict[str, Any]:
    pricing = fetch_json("/api/pricing")
    summary = fetch_json("/api/perf-metrics/summary?hours=24")

    pricing_items = pricing.get("data", []) if isinstance(pricing, dict) else []
    model_names = unique_keep_order(
        [str(item.get("model_name", "")).strip() for item in pricing_items if isinstance(item, dict) and item.get("model_name")]
    )

    metrics = summary.get("data", {}).get("models", []) if isinstance(summary, dict) else []
    metrics = [item for item in metrics if isinstance(item, dict)]

    success_rates = [to_float(item.get("success_rate")) for item in metrics if item.get("success_rate") is not None]
    healthy_metrics = [item for item in metrics if to_float(item.get("success_rate")) >= 90]
    latency_source = healthy_metrics or metrics
    tps_source = healthy_metrics or metrics
    latencies = [to_float(item.get("avg_latency_ms")) for item in latency_source if to_float(item.get("avg_latency_ms")) > 0]
    tps_values = [to_float(item.get("avg_tps")) for item in tps_source if to_float(item.get("avg_tps")) > 0]

    healthy_success_rates = [to_float(item.get("success_rate")) for item in healthy_metrics]
    avg_success = round(sum(healthy_success_rates) / len(healthy_success_rates), 2) if healthy_success_rates else (
        round(sum(success_rates) / len(success_rates), 2) if success_rates else 0.0
    )
    all_avg_success = round(sum(success_rates) / len(success_rates), 2) if success_rates else 0.0
    median_latency = int(statistics.median(latencies)) if latencies else 0
    median_tps = round(statistics.median(tps_values), 2) if tps_values else 0.0
    degraded_count = sum(1 for rate in success_rates if rate < 80)
    healthy_count = len(healthy_metrics)
    slow_count = sum(1 for latency in latencies if latency > 60000)

    ranked = []
    for item in metrics:
        name = public_model_name(item.get("model_name"))
        success = to_float(item.get("success_rate"))
        latency = to_float(item.get("avg_latency_ms"), 999999999)
        tps = to_float(item.get("avg_tps"))
        if success >= 90 and latency >= 1000:
            ranked.append((name, success, latency, tps))
    ranked.sort(key=lambda row: (-row[1], row[2], -row[3], row[0]))
    top_models = unique_keep_order([row[0] for row in ranked])[:5]
    if not top_models:
        fallback = sorted(
            ((public_model_name(item.get("model_name")), to_float(item.get("success_rate")), to_float(item.get("avg_latency_ms"), 999999999)) for item in metrics),
            key=lambda row: (-row[1], row[2], row[0]),
        )
        top_models = unique_keep_order([row[0] for row in fallback])[:5]

    # Per-model detail list (sorted: healthy first, then by success rate desc)
    model_list = []
    for item in sorted(metrics, key=lambda m: (-to_float(m.get("success_rate")), to_float(m.get("avg_latency_ms"), 999999999))):
        name = str(item.get("model_name") or "未命名模型").strip()
        success = to_float(item.get("success_rate"))
        latency = to_float(item.get("avg_latency_ms"))
        tps = to_float(item.get("avg_tps"))
        mstatus = "healthy" if success >= 90 else ("degraded" if success >= 80 else "down")
        model_list.append({
            "name": name,
            "success_rate": round(success, 1),
            "latency_ms": int(latency) if latency else 0,
            "tps": round(tps, 1) if tps else 0,
            "status": mstatus,
        })

    if not metrics:
        status = "warn"
    elif healthy_count >= 5:
        status = "ok"
    elif healthy_count >= 1:
        status = "warn"
    else:
        status = "down"

    return {
        "schema": 1,
        "source": BASE_URL,
        "window_hours": 24,
        "model_count": len(model_names),
        "monitored_count": len(metrics),
        "healthy_count": healthy_count,
        "avg_success_rate": avg_success,
        "all_avg_success_rate": all_avg_success,
        "median_latency_ms": median_latency,
        "median_tps": median_tps,
        "degraded_count": degraded_count,
        "slow_count": slow_count,
        "top_models": top_models,
        "models": model_list,
        "status": status,
        "stale": False,
    }


def comparable(payload: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in payload.items() if k not in VOLATILE_KEYS}


def load_existing() -> dict[str, Any] | None:
    if not OUTPUT.exists():
        return None
    try:
        return json.loads(OUTPUT.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def write_if_changed(core: dict[str, Any]) -> bool:
    existing = load_existing()
    if existing and comparable(existing) == core:
        print("monitor.json unchanged")
        return False

    now = datetime.now(timezone.utc)
    payload = {
        **core,
        "updated_at": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "updated_at_unix": int(now.timestamp()),
    }
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    return True


def main() -> int:
    try:
        core = build_core()
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        existing = load_existing() or {}
        core = comparable(existing) if existing else {
            "schema": 1,
            "source": BASE_URL,
            "window_hours": 24,
            "model_count": 0,
            "monitored_count": 0,
            "avg_success_rate": 0,
            "all_avg_success_rate": 0,
            "median_latency_ms": 0,
            "healthy_count": 0,
            "median_tps": 0,
            "degraded_count": 0,
            "slow_count": 0,
            "top_models": [],
            "status": "warn",
        }
        core["stale"] = True
        core["error"] = str(exc)[:160]
        print(f"warning: using stale monitor data: {exc}", file=sys.stderr)

    write_if_changed(core)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
