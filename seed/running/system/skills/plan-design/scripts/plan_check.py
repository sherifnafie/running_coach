#!/usr/bin/env python3
"""Sanity-check a training plan in coach.db against rules of thumb (read-only).

Summarises planned_workouts per Monday-Sunday week: planned volume, long run and its share, hard
sessions, rest days, ramp versus the previous week (and versus what the athlete has actually been
doing recently), and any session on a day the athlete said is unavailable.

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
from collections import defaultdict
from datetime import date, timedelta

HARD_TYPES = {"tempo", "intervals", "hills", "race"}
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def planned_km(row, assume_pace_s_km: float) -> float:
    if row["target_distance_m"]:
        return row["target_distance_m"] / 1000.0
    if row["target_duration_s"]:
        return row["target_duration_s"] / assume_pace_s_km
    return 0.0


def recent_actual_weekly_km(con, as_of: date, weeks: int = 4):
    start = as_of - timedelta(days=7 * weeks)
    rows = con.execute(
        "SELECT substr(started_at,1,10) d, distance_m FROM activities WHERE sport='run' AND substr(started_at,1,10) > ? AND substr(started_at,1,10) <= ?",
        (start.isoformat(), as_of.isoformat())).fetchall()
    if not rows:
        return None
    return sum((r["distance_m"] or 0) for r in rows) / 1000.0 / weeks


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="/workspace/data/coach.db")
    ap.add_argument("--from", dest="d_from", help="first date YYYY-MM-DD (default: earliest planned workout)")
    ap.add_argument("--to", dest="d_to", help="last date YYYY-MM-DD (default: latest planned workout)")
    ap.add_argument("--unavailable", default="", help="comma-separated weekdays the athlete cannot run, e.g. tue,sat")
    ap.add_argument("--as-of", help="today's date (situation report); enables comparison with the last 4 weeks of actual running")
    ap.add_argument("--assume-pace", type=float, default=360.0, help="s/km used to convert duration-only sessions to km (default 360)")
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
    rows = con.execute(q + " ORDER BY date", p).fetchall()
    if not rows:
        print("No planned workouts in range.")
        return 0

    unavailable = {d.strip().lower()[:3] for d in args.unavailable.split(",") if d.strip()}
    bad = unavailable - set(DAYS)
    if bad:
        print(f"error: unknown weekday(s): {', '.join(sorted(bad))}", file=sys.stderr)
        return 2

    weeks: dict[date, list] = defaultdict(list)
    for r in rows:
        weeks[week_start(date.fromisoformat(r["date"]))].append(r)
    first, last = min(weeks), max(weeks)
    all_weeks = []
    w = first
    while w <= last:
        all_weeks.append(w)
        w += timedelta(days=7)

    recent = recent_actual_weekly_km(con, date.fromisoformat(args.as_of)) if args.as_of else None
    out, flags = [], []
    prev_km = None
    since_down = 0
    for i, ws in enumerate(all_weeks):
        rs = weeks.get(ws, [])
        run_rows = [r for r in rs if r["type"] not in ("rest", "strength", "cross", "other")]
        kms = [planned_km(r, args.assume_pace) for r in run_rows]
        km = sum(kms)
        longest = max(kms, default=0.0)
        hard = [r for r in run_rows if r["type"] in HARD_TYPES]
        days_with_run = {r["date"] for r in run_rows}
        rest_days = 7 - len(days_with_run)
        hard_dates = sorted(date.fromisoformat(r["date"]) for r in hard)
        consecutive_hard = any((b - a).days == 1 for a, b in zip(hard_dates, hard_dates[1:]))
        viol = [r for r in rs if r["type"] != "rest" and DAYS[date.fromisoformat(r["date"]).weekday()] in unavailable]
        ramp = (km - prev_km) / prev_km * 100 if prev_km else None
        row = {"week_start": ws.isoformat(), "planned_km": round(km, 1), "runs": len(run_rows),
               "longest_km": round(longest, 1), "long_share": round(longest / km, 2) if km else None,
               "hard_sessions": len(hard), "rest_days": rest_days,
               "ramp_pct": round(ramp) if ramp is not None else None, "flags": []}
        if recent is not None and i == 0 and recent > 0 and km > 0:
            row["vs_recent_actual_pct"] = round((km - recent) / recent * 100)
            if km > recent * 1.2:
                row["flags"].append(f"first week is {row['vs_recent_actual_pct']:+d}% vs your last 4 weeks of actual running ({recent:.1f} km/wk)")
        if ramp is not None and ramp > 15 and (prev_km or 0) >= 10:
            row["flags"].append(f"volume ramp {ramp:+.0f}% over the previous week (>~15%: needs a reason)")
        elif ramp is not None and ramp > 10 and (prev_km or 0) >= 10:
            row["flags"].append(f"volume ramp {ramp:+.0f}% (above the ~10% rule of thumb)")
        if km > 0 and longest / km > 0.40 and len(run_rows) >= 3:
            row["flags"].append(f"long run is {longest / km:.0%} of the week's volume (typical ~25-35%)")
        if len(hard) >= 3:
            row["flags"].append(f"{len(hard)} hard sessions in one week")
        if consecutive_hard:
            row["flags"].append("hard sessions on consecutive days")
        if run_rows and rest_days < 1:
            row["flags"].append("no rest day (every day has a run)")
        if viol:
            row["flags"].append("session(s) on unavailable days: " + ", ".join(f"{v['date']} ({v['title']})" for v in viol))
        # down-week detection
        if prev_km and km < prev_km * 0.85:
            since_down = 0
        else:
            since_down += 1
        if since_down >= 5 and len(all_weeks) >= 5:
            row["flags"].append("5+ build weeks in a row without a down week")
        out.append(row)
        flags.extend(row["flags"])
        if km > 0 and (rs or True):
            prev_km = km

    # taper hint: race rows
    races = con.execute("SELECT date, name, priority FROM races WHERE priority='A' ORDER BY date").fetchall() if \
        con.execute("SELECT 1 FROM sqlite_master WHERE name='races'").fetchone() else []
    taper_notes = []
    for rc in races:
        rd = date.fromisoformat(rc["date"])
        rws = week_start(rd)
        if rws in weeks or rws - timedelta(days=7) in weeks:
            wk = {o["week_start"]: o for o in out}
            race_week = wk.get(rws.isoformat())
            peak = max((o["planned_km"] for o in out if date.fromisoformat(o["week_start"]) < rws), default=0)
            if race_week and peak and race_week["planned_km"] > peak * 0.7:
                taper_notes.append(f"A race '{rc['name']}' on {rc['date']}: race-week volume {race_week['planned_km']} km is >70% of the peak week ({peak} km); is there a taper?")
    con.close()

    if args.json:
        print(json.dumps({"weeks": out, "taper_notes": taper_notes}, indent=2))
        return 0
    hdr = f"{'week of':<11}{'km':>7}{'runs':>5}{'long':>6}{'long%':>6}{'hard':>5}{'rest':>5}{'ramp':>7}"
    print(hdr)
    print("-" * len(hdr))
    for o in out:
        share = f"{int(o['long_share'] * 100)}%" if o["long_share"] is not None else "-"
        ramp = f"{o['ramp_pct']:+d}%" if o["ramp_pct"] is not None else "-"
        print(f"{o['week_start']:<11}{o['planned_km']:>7.1f}{o['runs']:>5}{o['longest_km']:>6.1f}{share:>6}{o['hard_sessions']:>5}{o['rest_days']:>5}{ramp:>7}")
        for f in o["flags"]:
            print(f"    ! {f}")
    for t in taper_notes:
        print(f"! {t}")
    print(f"\n{len(flags) + len(taper_notes)} flag(s). Distances are planned (duration-only sessions converted at {args.assume_pace:.0f} s/km). "
          "Flags are prompts for judgment, not verdicts.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
