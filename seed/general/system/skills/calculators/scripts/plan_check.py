#!/usr/bin/env python3
"""Sanity-check a training plan in coach.db against rules of thumb (read-only). Works for any sport.

Summarises planned_workouts per Monday-Sunday week: planned time and sessions (by sport), hard and key
sessions, rest days, ramp versus the previous week (and versus what the athlete has actually been doing
recently), sessions on days the athlete said are unavailable, and hard sessions on consecutive days.
When running is planned it also reports run km, the long run and its share of run volume. A goal event
with priority A (goal_events, or races in older workspaces) gets a taper check.

Planned time comes from target_duration_s. A run or walk with only a distance is converted at
--assume-pace; other sessions without a duration are counted and flagged (time totals then understate).
Workspaces without a planned_workouts.sport column are treated as running plans with strength rows.

The flags are heuristics for *your judgment* (and a reviewer helper's), not pass/fail rules. A flag
with a good reason is fine; say the reason in the plan notes.

Examples:
    plan_check.py --from 2026-10-05 --to 2027-01-03
    plan_check.py --from 2026-10-05 --to 2026-12-06 --unavailable tue,sat --as-of 2026-10-07
    plan_check.py --json
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta

HARD_TYPES = {"tempo", "intervals", "hills", "race", "competition", "test", "heavy", "power", "conditioning"}
REST_TYPES = {"rest"}
DISTANCE_SPORTS = {"run", "walk", "hike"}
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def has_column(con, table: str, column: str) -> bool:
    return any(r[1] == column for r in con.execute(f"PRAGMA table_info({table})"))


def has_table(con, name: str) -> bool:
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def session_sport(row: dict) -> str | None:
    if row["type"] in REST_TYPES:
        return None
    if row.get("sport"):
        return str(row["sport"]).lower()
    return "strength" if row["type"] == "strength" else "run" if row["type"] not in ("cross", "other") else row["type"]


def planned_seconds(row: dict, sport: str | None, assume_pace_s_km: float) -> float | None:
    if row["target_duration_s"]:
        return float(row["target_duration_s"])
    if row["target_distance_m"] and sport in DISTANCE_SPORTS:
        return row["target_distance_m"] / 1000.0 * assume_pace_s_km
    return None


def planned_run_km(row: dict, assume_pace_s_km: float) -> float:
    if row["target_distance_m"]:
        return row["target_distance_m"] / 1000.0
    if row["target_duration_s"]:
        return row["target_duration_s"] / assume_pace_s_km
    return 0.0


def recent_actual(con, as_of: date, weeks: int = 4) -> dict:
    start = as_of - timedelta(days=7 * weeks)
    rows = con.execute(
        "SELECT sport, duration_s, distance_m FROM activities WHERE substr(started_at,1,10) > ? AND substr(started_at,1,10) <= ?",
        (start.isoformat(), as_of.isoformat())).fetchall()
    if not rows:
        return {}
    known = [r["duration_s"] for r in rows if r["duration_s"] is not None]
    run_km = sum((r["distance_m"] or 0) for r in rows if (r["sport"] or "") == "run") / 1000.0
    return {
        "hours_per_week": sum(known) / 3600.0 / weeks if known else None,
        "sessions_per_week": len(rows) / weeks,
        "sessions_without_duration": len(rows) - len(known),
        "run_km_per_week": run_km / weeks if any((r["sport"] or "") == "run" for r in rows) else None,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="/workspace/data/coach.db")
    ap.add_argument("--from", dest="d_from", help="first date YYYY-MM-DD (default: earliest planned workout)")
    ap.add_argument("--to", dest="d_to", help="last date YYYY-MM-DD (default: latest planned workout)")
    ap.add_argument("--unavailable", default="", help="comma-separated weekdays the athlete cannot train, e.g. tue,sat")
    ap.add_argument("--as-of", help="today's date (situation report); enables comparison with the last 4 weeks of actual training")
    ap.add_argument("--assume-pace", type=float, default=360.0, help="s/km to convert between distance and time for runs and walks (default 360)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.exists(args.db):
        print(f"error: database not found: {args.db}", file=sys.stderr)
        return 2
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    q = "SELECT * FROM planned_workouts WHERE status NOT IN ('skipped','moved')"
    p = []
    if args.d_from:
        q += " AND date >= ?"; p.append(args.d_from)
    if args.d_to:
        q += " AND date <= ?"; p.append(args.d_to)
    rows = [dict(r) for r in con.execute(q + " ORDER BY date", p).fetchall()]
    if not rows:
        print("No planned workouts in range.")
        return 0
    legacy = not has_column(con, "planned_workouts", "sport")
    has_key = has_column(con, "planned_workouts", "key")

    unavailable = {d.strip().lower()[:3] for d in args.unavailable.split(",") if d.strip()}
    bad = unavailable - set(DAYS)
    if bad:
        print(f"error: unknown weekday(s): {', '.join(sorted(bad))}", file=sys.stderr)
        return 2

    weeks: dict[date, list] = defaultdict(list)
    for r in rows:
        r["_sport"] = session_sport(r)
        weeks[week_start(date.fromisoformat(r["date"]))].append(r)
    first, last = min(weeks), max(weeks)
    all_weeks = []
    w = first
    while w <= last:
        all_weeks.append(w)
        w += timedelta(days=7)
    any_running = any(r["_sport"] == "run" for r in rows)

    recent = recent_actual(con, date.fromisoformat(args.as_of)) if args.as_of else {}
    out, flags = [], []
    prev_h = None
    since_down = 0
    for i, ws in enumerate(all_weeks):
        rs = weeks.get(ws, [])
        sessions = [r for r in rs if r["_sport"] is not None]
        secs = [planned_seconds(r, r["_sport"], args.assume_pace) for r in sessions]
        no_duration = [r for r, s in zip(sessions, secs) if s is None]
        hours = sum(s for s in secs if s is not None) / 3600.0
        by_sport = Counter(r["_sport"] for r in sessions)
        hard = [r for r in sessions if r["type"] in HARD_TYPES]
        key = [r for r in sessions if has_key and r.get("key")]
        days_with_training = {r["date"] for r in sessions}
        rest_days = 7 - len(days_with_training)
        hard_dates = sorted({date.fromisoformat(r["date"]) for r in hard})
        consecutive_hard = any((b - a).days == 1 for a, b in zip(hard_dates, hard_dates[1:]))
        viol = [r for r in sessions if DAYS[date.fromisoformat(r["date"]).weekday()] in unavailable]
        ramp = (hours - prev_h) / prev_h * 100 if prev_h else None
        row = {"week_start": ws.isoformat(), "planned_hours": round(hours, 2), "sessions": len(sessions),
               "by_sport": dict(by_sport), "hard_sessions": len(hard), "key_sessions": len(key), "rest_days": rest_days,
               "ramp_pct": round(ramp) if ramp is not None else None, "sessions_without_duration": len(no_duration), "flags": []}
        if any_running:
            runs = [r for r in sessions if r["_sport"] == "run"]
            kms = [planned_run_km(r, args.assume_pace) for r in runs]
            km = sum(kms)
            longest = max(kms, default=0.0)
            row.update({"run_km": round(km, 1), "longest_run_km": round(longest, 1), "long_run_share": round(longest / km, 2) if km else None})
            if km > 0 and longest / km > 0.40 and len(runs) >= 3:
                row["flags"].append(f"long run is {longest / km:.0%} of the week's running (typical ~25-35%)")
            if i == 0 and recent.get("run_km_per_week") and km > recent["run_km_per_week"] * 1.2:
                row["flags"].append(f"first week's running is {round((km / recent['run_km_per_week'] - 1) * 100):+d}% vs the last 4 weeks of actual running ({recent['run_km_per_week']:.1f} km/wk)")
        if i == 0 and recent.get("hours_per_week") and hours > 0:
            row["vs_recent_actual_pct"] = round((hours - recent["hours_per_week"]) / recent["hours_per_week"] * 100)
            if hours > recent["hours_per_week"] * 1.2:
                row["flags"].append(f"first week is {row['vs_recent_actual_pct']:+d}% vs the last 4 weeks of actual training ({recent['hours_per_week']:.1f} h/wk)")
        if ramp is not None and ramp > 15 and (prev_h or 0) >= 1:
            row["flags"].append(f"planned time ramp {ramp:+.0f}% over the previous week (>~15%: needs a reason)")
        elif ramp is not None and ramp > 10 and (prev_h or 0) >= 1:
            row["flags"].append(f"planned time ramp {ramp:+.0f}% (above the ~10% rule of thumb)")
        if len(hard) >= 4:
            row["flags"].append(f"{len(hard)} hard sessions in one week (all sports together)")
        if consecutive_hard:
            row["flags"].append("hard sessions on consecutive days")
        if sessions and rest_days < 1:
            row["flags"].append("no rest day (every day has a session)")
        if no_duration:
            row["flags"].append(f"{len(no_duration)} session(s) without target_duration_s; planned time understates the week")
        if viol:
            row["flags"].append("session(s) on unavailable days: " + ", ".join(f"{v['date']} ({v['title']})" for v in viol))
        if prev_h and hours < prev_h * 0.85:
            since_down = 0
        else:
            since_down += 1
        if since_down >= 5 and len(all_weeks) >= 5:
            row["flags"].append("5+ build weeks in a row without a down week")
        out.append(row)
        flags.extend(row["flags"])
        if hours > 0:
            prev_h = hours

    events = []
    if has_table(con, "goal_events"):
        events = con.execute("SELECT date, name, priority FROM goal_events WHERE priority='A' ORDER BY date").fetchall()
    elif has_table(con, "races"):
        events = con.execute("SELECT date, name, priority FROM races WHERE priority='A' ORDER BY date").fetchall()
    taper_notes = []
    wk = {o["week_start"]: o for o in out}
    for ev in events:
        ews = week_start(date.fromisoformat(ev["date"]))
        event_week = wk.get(ews.isoformat())
        peak = max((o["planned_hours"] for o in out if date.fromisoformat(o["week_start"]) < ews), default=0)
        if event_week and peak and event_week["planned_hours"] > peak * 0.7:
            taper_notes.append(f"A event '{ev['name']}' on {ev['date']}: event-week planned time {event_week['planned_hours']} h is >70% of the peak week ({peak} h); is there a taper?")
    con.close()

    if args.json:
        print(json.dumps({"weeks": out, "taper_notes": taper_notes, "recent_actual": recent, "legacy_schema": legacy}, indent=2))
        return 0
    run_cols = any_running
    hdr = f"{'week of':<11}{'hours':>7}{'sess':>5}{'hard':>5}{'key':>4}{'rest':>5}{'ramp':>7}" + (f"{'run km':>8}{'long':>6}{'long%':>6}" if run_cols else "") + "  by sport"
    print(hdr)
    print("-" * len(hdr))
    for o in out:
        ramp = f"{o['ramp_pct']:+d}%" if o["ramp_pct"] is not None else "-"
        line = f"{o['week_start']:<11}{o['planned_hours']:>7.1f}{o['sessions']:>5}{o['hard_sessions']:>5}{o['key_sessions']:>4}{o['rest_days']:>5}{ramp:>7}"
        if run_cols:
            share = f"{int(o['long_run_share'] * 100)}%" if o.get("long_run_share") is not None else "-"
            line += f"{o['run_km']:>8.1f}{o['longest_run_km']:>6.1f}{share:>6}"
        line += "  " + (", ".join(f"{s} {n}" for s, n in sorted(o["by_sport"].items())) or "-")
        print(line)
        for f in o["flags"]:
            print(f"    ! {f}")
    for t in taper_notes:
        print(f"! {t}")
    note = " (legacy schema: no planned_workouts.sport; sports inferred from type)" if legacy else ""
    print(f"\n{len(flags) + len(taper_notes)} flag(s){note}. Run/walk sessions with only a distance are converted at {args.assume_pace:.0f} s/km. "
          "Flags are prompts for judgment, not verdicts.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
