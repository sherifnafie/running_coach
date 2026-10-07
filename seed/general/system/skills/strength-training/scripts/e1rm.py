#!/usr/bin/env python3
"""Estimated one-rep max (e1RM) and weekly lifting summaries from coach.db's exercise_sets.

Two modes:
  e1rm.py --calc 100x5            one set: e1RM by Epley, Brzycki and an RPE-adjusted Epley
  e1rm.py --calc 100x5@8          the same set at RPE 8 (2 reps in reserve)
  e1rm.py --as-of 2026-10-07      weekly summary per exercise from /workspace/data/coach.db (read-only)

The weekly summary groups working sets (is_warmup = 0) by exercise and Monday-to-Sunday week of
performed_at (local date as stored), and prints: best e1RM (from sets of <= --max-reps reps with a
load), the top set, hard sets (RPE >= 7 or RIR <= 3), sets with no effort rating, and tonnage
(reps x load). Sets without a load (bodyweight, timed) are counted but have no e1RM.

e1RM is an estimate. It is reasonable for sets of up to ~6 reps taken close to failure and gets
increasingly wrong above ~10 reps or when a set ended far from failure. The RPE-adjusted value adds
reps in reserve (10 - RPE) to the reps performed before applying Epley. Trends over weeks are more
useful than any single number. Nothing is invented: missing loads, reps or RPE stay missing.

Examples:
    e1rm.py --calc 140x3@8.5
    e1rm.py --as-of 2026-10-07 --weeks 8
    e1rm.py --as-of 2026-10-07 --exercise "Back squat" --units lb --json
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import date, timedelta

LB_PER_KG = 2.2046226218


def epley(load: float, reps: float) -> float:
    return load if reps <= 1 else load * (1 + reps / 30.0)


def brzycki(load: float, reps: float) -> float | None:
    if reps >= 37:
        return None
    return load if reps <= 1 else load * 36.0 / (37.0 - reps)


def rpe_adjusted(load: float, reps: float, rpe: float | None) -> float | None:
    if rpe is None:
        return None
    rir = max(0.0, 10.0 - rpe)
    return epley(load, reps + rir)


def fmt_load(kg: float | None, units: str) -> str:
    if kg is None:
        return "-"
    v = kg * LB_PER_KG if units == "lb" else kg
    return f"{v:.1f} {units}"


def calc(spec: str, units: str, as_json: bool) -> int:
    m = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*[xX×]\s*([0-9]+)\s*(?:@\s*([0-9]+(?:\.[0-9]+)?))?\s*", spec)
    if not m:
        print("--calc expects LOADxREPS or LOADxREPS@RPE, e.g. 100x5 or 100x5@8 (load in --units)", file=sys.stderr)
        return 2
    load = float(m.group(1))
    if units == "lb":
        load /= LB_PER_KG
    reps = float(m.group(2))
    rpe = float(m.group(3)) if m.group(3) else None
    if rpe is not None and not 1 <= rpe <= 10:
        print("RPE must be between 1 and 10", file=sys.stderr)
        return 2
    out = {
        "load_kg": round(load, 2), "reps": reps, "rpe": rpe,
        "epley_kg": round(epley(load, reps), 1),
        "brzycki_kg": None if brzycki(load, reps) is None else round(brzycki(load, reps), 1),
        "rpe_adjusted_epley_kg": None if rpe is None else round(rpe_adjusted(load, reps, rpe), 1),
        "warnings": [],
    }
    if reps > 10:
        out["warnings"].append("more than 10 reps: estimates are unreliable; use the trend, not the number")
    if rpe is not None and rpe < 7:
        out["warnings"].append("RPE below 7: the set was far from failure, so reps-in-reserve guesses dominate the estimate")
    if as_json:
        print(json.dumps(out, indent=2))
        return 0
    print(f"Set: {fmt_load(load, units)} x {int(reps)}" + (f" @ RPE {rpe:g}" if rpe is not None else ""))
    print(f"  Epley          {fmt_load(out['epley_kg'], units)}")
    print(f"  Brzycki        {fmt_load(out['brzycki_kg'], units)}")
    if rpe is not None:
        print(f"  RPE-adjusted   {fmt_load(out['rpe_adjusted_epley_kg'], units)}  (Epley with {int(reps)} + {10 - rpe:g} reps in reserve)")
    for w in out["warnings"]:
        print(f"  ! {w}")
    print("Estimates, not tested maxes.")
    return 0


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def summary(args: argparse.Namespace) -> int:
    try:
        con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    except sqlite3.Error as e:
        print(f"cannot open {args.db}: {e}", file=sys.stderr)
        return 2
    con.row_factory = sqlite3.Row
    if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='exercise_sets'").fetchone():
        print("no exercise_sets table in this database (see the strength-training skill and data/schema.md)", file=sys.stderr)
        return 2
    as_of = date.fromisoformat(args.as_of)
    first = week_start(as_of) - timedelta(weeks=args.weeks - 1)
    q = ("SELECT exercise, substr(performed_at,1,10) AS d, reps, load_kg, rpe, rir, is_warmup "
         "FROM exercise_sets WHERE substr(performed_at,1,10) >= ? AND substr(performed_at,1,10) <= ?")
    params: list = [first.isoformat(), as_of.isoformat()]
    if args.exercise:
        q += " AND lower(exercise) = lower(?)"
        params.append(args.exercise)
    rows = con.execute(q + " ORDER BY performed_at, set_index", params).fetchall()

    weeks: dict[str, dict[str, dict]] = defaultdict(dict)
    for r in rows:
        if r["is_warmup"]:
            continue
        try:
            wk = week_start(date.fromisoformat(r["d"])).isoformat()
        except ValueError:
            continue
        cell = weeks[r["exercise"]].setdefault(wk, {"week_start": wk, "sets": 0, "hard_sets": 0, "unrated_sets": 0,
                                                    "tonnage_kg": 0.0, "best_e1rm_kg": None, "top_set": None})
        cell["sets"] += 1
        rpe, rir = r["rpe"], r["rir"]
        if rpe is None and rir is not None:
            rpe = 10 - rir
        if rpe is None:
            cell["unrated_sets"] += 1
        elif rpe >= 7:
            cell["hard_sets"] += 1
        reps, load = r["reps"], r["load_kg"]
        if reps is not None and load is not None:
            cell["tonnage_kg"] += reps * load
            top = cell["top_set"]
            if top is None or load > top["load_kg"] or (load == top["load_kg"] and reps > top["reps"]):
                cell["top_set"] = {"load_kg": load, "reps": reps, "rpe": rpe}
            if 1 <= reps <= args.max_reps:
                est = epley(load, reps)
                if cell["best_e1rm_kg"] is None or est > cell["best_e1rm_kg"]:
                    cell["best_e1rm_kg"] = est

    result = {"as_of": as_of.isoformat(), "weeks": args.weeks, "formula": "epley", "max_reps": args.max_reps, "exercises": {}}
    for ex, cells in sorted(weeks.items(), key=lambda kv: -sum(c["sets"] for c in kv[1].values())):
        lst = []
        for wk in sorted(cells):
            c = cells[wk]
            c["tonnage_kg"] = round(c["tonnage_kg"], 1) if c["top_set"] else None
            if c["best_e1rm_kg"] is not None:
                c["best_e1rm_kg"] = round(c["best_e1rm_kg"], 1)
            lst.append(c)
        result["exercises"][ex] = lst

    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    if not result["exercises"]:
        print(f"No working sets between {first} and {as_of}" + (f" for '{args.exercise}'" if args.exercise else "") + ".")
        return 0
    print(f"Lifting summary as of {as_of} · last {args.weeks} weeks · e1RM: Epley, sets of <= {args.max_reps} reps · units: {args.units}")
    for ex, lst in result["exercises"].items():
        print(f"\n{ex}")
        print(f"  {'week of':<11}{'sets':>5}{'hard':>5}{'unrated':>8}{'top set':>18}{'best e1RM':>13}{'tonnage':>12}")
        for c in lst:
            top = c["top_set"]
            top_s = f"{fmt_load(top['load_kg'], args.units)} x {top['reps']:g}" if top else "-"
            print(f"  {c['week_start']:<11}{c['sets']:>5}{c['hard_sets']:>5}{c['unrated_sets']:>8}{top_s:>18}"
                  f"{fmt_load(c['best_e1rm_kg'], args.units):>13}{fmt_load(c['tonnage_kg'], args.units):>12}")
    print("\nEstimates, not tested maxes. 'unrated' sets have no RPE/RIR: ask, don't guess.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--calc", help="one set: LOADxREPS or LOADxREPS@RPE (load in --units)")
    ap.add_argument("--db", default="/workspace/data/coach.db")
    ap.add_argument("--as-of", help="athlete-local date YYYY-MM-DD (from the situation report)")
    ap.add_argument("--weeks", type=int, default=8)
    ap.add_argument("--exercise", help="limit to one exercise name (case-insensitive exact match)")
    ap.add_argument("--max-reps", type=int, default=10, help="ignore sets above this many reps for e1RM (default 10)")
    ap.add_argument("--units", choices=["kg", "lb"], default="kg")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    if args.calc:
        return calc(args.calc, args.units, args.json)
    if not args.as_of:
        ap.error("--as-of is required for the weekly summary (or use --calc)")
    if args.weeks < 1:
        ap.error("--weeks must be >= 1")
    return summary(args)


if __name__ == "__main__":
    sys.exit(main())
