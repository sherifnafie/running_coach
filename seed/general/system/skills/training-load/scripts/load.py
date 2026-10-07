#!/usr/bin/env python3
"""Training-load summaries from coach.db: weekly totals, session-RPE load, monotony/strain, ACWR.

Reads `activities` (read-only) from /workspace/data/coach.db by default. Works for any sport or mix of
sports: load = session RPE x duration in minutes (Foster et al. 2001), in arbitrary units (AU), so a
run, a lifting session and a football practice land on one scale. Weekly time and sessions are shown
by sport; distance columns (km, longest, share) are shown for one distance sport (--distance-sport,
default: the sport with the most sessions that have a distance, if any). Sessions without an RPE are
NOT given an invented one: they are counted and listed so you can ask the athlete (or pass
--impute-rpe to see a flagged what-if).

Weeks run Monday to Sunday by the *local date written in started_at* (which carries the
athlete's own UTC offset), so no timezone conversion is done.

Pass --as-of with today's date from the situation report; the sandbox clock is not authoritative.

Examples:
    load.py --as-of 2026-10-07
    load.py --as-of 2026-10-07 --weeks 12 --metric time
    load.py --as-of 2026-10-07 --distance-sport run --metric distance
    load.py --as-of 2026-10-07 --json
    load.py --db /workspace/data/coach.db --as-of 2026-10-07 --sports run,strength
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from collections import defaultdict
from datetime import date, timedelta

CAVEATS = """\
Read this as a conversation prompt, not a rule. Acute:chronic workload ratios have weak and contested
predictive value for injury (the ratio is mathematically coupled to its own inputs, thresholds vary
by sport and data source, and results do not transfer reliably to recreational athletes). They also
depend entirely on honest, complete RPE and duration logging. A ratio is only meaningful with >= 4
weeks of consistent history before the as-of date. Use the trend, the athlete's own report, and
sudden spikes in a single week as the signals; do not tell an athlete a number is 'safe' or 'dangerous'."""


def parse_date(s: str) -> date:
    return date.fromisoformat(s)


def local_date(started_at: str) -> date:
    return date.fromisoformat(started_at[:10])


def week_start(d: date) -> date:
    return d - timedelta(days=d.weekday())


def load_activities(db: str, sports: set[str] | None):
    uri = f"file:{db}?mode=ro"
    try:
        con = sqlite3.connect(uri, uri=True)
    except sqlite3.OperationalError as e:
        raise SystemExit(f"error: cannot open {db} read-only: {e}")
    con.row_factory = sqlite3.Row
    try:
        rows = con.execute(
            "SELECT id, started_at, sport, title, distance_m, duration_s, moving_s, rpe FROM activities ORDER BY started_at"
        ).fetchall()
    except sqlite3.OperationalError as e:
        raise SystemExit(f"error: could not read activities ({e}). Is this the coach.db with the starter schema?")
    finally:
        con.close()
    acts = []
    for r in rows:
        if sports and r["sport"] not in sports:
            continue
        try:
            d = local_date(r["started_at"])
        except (ValueError, TypeError):
            print(f"warning: skipping activity {r['id']} with unparseable started_at {r['started_at']!r}", file=sys.stderr)
            continue
        acts.append({
            "id": r["id"], "date": d, "sport": r["sport"], "title": r["title"],
            "distance_m": r["distance_m"], "duration_s": r["duration_s"], "moving_s": r["moving_s"], "rpe": r["rpe"],
        })
    return acts


def pick_distance_sport(acts) -> str | None:
    counts: dict[str, int] = defaultdict(int)
    for a in acts:
        if a["distance_m"]:
            counts[a["sport"]] += 1
    return max(counts, key=lambda s: (counts[s], s == "run")) if counts else None


def session_value(a: dict, metric: str, impute_rpe: float | None, distance_sport: str | None = None) -> tuple[float | None, bool]:
    """Return (value, imputed). None means the metric is unknown for this session."""
    if metric == "distance":
        return (a["distance_m"] / 1000.0, False) if a["distance_m"] is not None and a["sport"] == distance_sport else (None, False)
    if metric == "time":
        return (a["duration_s"] / 60.0, False) if a["duration_s"] is not None else (None, False)
    # srpe
    if a["duration_s"] is None:
        return None, False
    rpe = a["rpe"]
    if rpe is None:
        if impute_rpe is None:
            return None, False
        return impute_rpe * a["duration_s"] / 60.0, True
    return rpe * a["duration_s"] / 60.0, False


def daily_series(acts, metric, impute_rpe, distance_sport=None):
    daily: dict[date, float] = defaultdict(float)
    missing, imputed = [], []
    for a in acts:
        v, was_imputed = session_value(a, metric, impute_rpe, distance_sport)
        if v is None:
            if metric == "srpe":
                missing.append(a)
            continue
        if was_imputed:
            imputed.append(a)
        daily[a["date"]] += v
    return daily, missing, imputed


def weekly_table(acts, daily, as_of: date, weeks: int, distance_sport: str | None):
    this_week = week_start(as_of)
    starts = [this_week - timedelta(weeks=i) for i in range(weeks, -1, -1)]  # oldest first, includes current
    table = []
    prev_h = None  # training hours of the previous *full* week
    for ws in starts:
        days = [ws + timedelta(days=i) for i in range(7)]
        week_acts = [a for a in acts if ws <= a["date"] <= ws + timedelta(days=6) and a["date"] <= as_of]
        dist_acts = [a for a in week_acts if distance_sport and a["sport"] == distance_sport]
        km = sum((a["distance_m"] or 0) for a in dist_acts) / 1000.0
        longest = max(((a["distance_m"] or 0) for a in dist_acts), default=0) / 1000.0
        time_h = sum((a["duration_s"] or 0) for a in week_acts) / 3600.0
        by_sport: dict[str, int] = defaultdict(int)
        for a in week_acts:
            by_sport[a["sport"]] += 1
        loads = [daily.get(d, 0.0) for d in days if d <= as_of]
        full_week = ws + timedelta(days=6) <= as_of
        total = sum(loads)
        mono = strain = None
        if full_week and len(loads) == 7:
            mean = total / 7
            sd = math.sqrt(sum((x - mean) ** 2 for x in loads) / 7)
            if sd > 0:
                mono = mean / sd
                strain = total * mono
        row = {
            "week_start": ws.isoformat(), "partial": not full_week,
            "sessions": len(week_acts), "by_sport": dict(by_sport), "time_h": round(time_h, 2),
            "sessions_missing_duration": sum(1 for a in week_acts if a["duration_s"] is None),
            "ramp_pct": round((time_h - prev_h) / prev_h * 100, 0) if (full_week and prev_h and prev_h > 0) else None,
            "distance_sport": distance_sport,
            "distance_sessions": len(dist_acts),
            "distance_km": round(km, 1),
            "longest_km": round(longest, 1),
            "long_share": round(longest / km, 2) if km > 0 else None,
            "load": round(total, 0),
            "monotony": round(mono, 2) if mono is not None else None,
            "strain": round(strain, 0) if strain is not None else None,
            "sessions_missing_rpe": sum(1 for a in week_acts if a["rpe"] is None),
        }
        table.append(row)
        if full_week:
            prev_h = time_h
    return table


def acwr(daily: dict[date, float], as_of: date, first_date: date | None):
    def window_sum(end: date, days: int) -> float:
        return sum(daily.get(end - timedelta(days=i), 0.0) for i in range(days))

    acute = window_sum(as_of, 7) / 7
    chronic28 = window_sum(as_of, 28) / 28
    chronic_prior21 = sum(daily.get(as_of - timedelta(days=i), 0.0) for i in range(7, 28)) / 21
    out = {
        "acute_daily_mean": round(acute, 1),
        "chronic_daily_mean_28d": round(chronic28, 1),
        "ratio_rolling_coupled": round(acute / chronic28, 2) if chronic28 > 0 else None,
        "ratio_rolling_uncoupled": round(acute / chronic_prior21, 2) if chronic_prior21 > 0 else None,
    }
    # EWMA version (Williams et al. 2017): lambda = 2 / (N + 1)
    if first_date and first_date <= as_of:
        la, lc = 2 / (7 + 1), 2 / (28 + 1)
        ea = ec = 0.0
        d = first_date
        while d <= as_of:
            x = daily.get(d, 0.0)
            ea = x * la + (1 - la) * ea
            ec = x * lc + (1 - lc) * ec
            d += timedelta(days=1)
        out["ratio_ewma"] = round(ea / ec, 2) if ec > 0 else None
    else:
        out["ratio_ewma"] = None
    history_days = (as_of - first_date).days + 1 if first_date else 0
    out["history_days"] = history_days
    out["window_full"] = history_days >= 28
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="/workspace/data/coach.db", help="path to coach.db (default /workspace/data/coach.db)")
    ap.add_argument("--as-of", required=False, help="local date YYYY-MM-DD to compute up to (use today's date from the situation report)")
    ap.add_argument("--weeks", type=int, default=8, help="number of weeks of history in the table (default 8)")
    ap.add_argument("--metric", choices=["srpe", "time", "distance"], default="srpe",
                    help="load metric for monotony/strain/ACWR (default srpe = RPE x minutes)")
    ap.add_argument("--sports", help="comma-separated sports to include (default: all). e.g. run  or  run,bike,strength")
    ap.add_argument("--distance-sport", help="sport whose distance is summarised and used by --metric distance (default: auto)")
    ap.add_argument("--impute-rpe", type=float, help="WHAT-IF only: treat sessions with no RPE as this RPE (flagged in output)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    sports = set(s.strip() for s in args.sports.split(",")) if args.sports else None
    acts = load_activities(args.db, sports)
    if not acts:
        print("No activities found for the chosen filters. Nothing to compute.")
        return 0

    if args.as_of:
        as_of = parse_date(args.as_of)
    else:
        as_of = date.today()
        print(f"note: --as-of not given; using the sandbox date {as_of}. Pass today's date from the situation report.", file=sys.stderr)

    acts = [a for a in acts if a["date"] <= as_of]
    if not acts:
        print("No activities on or before the as-of date.")
        return 0
    distance_sport = args.distance_sport or pick_distance_sport(acts)
    if args.metric == "distance" and not distance_sport:
        print("No sessions with a distance: --metric distance has nothing to measure. Use srpe or time.")
        return 0
    daily, missing, imputed = daily_series(acts, args.metric, args.impute_rpe, distance_sport)
    table = weekly_table(acts, daily, as_of, args.weeks, distance_sport)
    first = min(a["date"] for a in acts)
    ratios = acwr(daily, as_of, first)

    by_sport: dict[str, int] = defaultdict(int)
    for a in acts:
        by_sport[a["sport"]] += 1

    result = {
        "as_of": as_of.isoformat(), "metric": args.metric, "sports_counted": dict(by_sport), "distance_sport": distance_sport,
        "weeks": table, "acwr": ratios,
        "sessions_missing_rpe": [{"id": a["id"], "date": a["date"].isoformat(), "title": a["title"]} for a in missing][-20:],
        "imputed_rpe_sessions": len(imputed),
    }
    if args.json:
        print(json.dumps(result, indent=2))
        return 0

    unit = {"srpe": "AU", "time": "min", "distance": f"km ({distance_sport})"}[args.metric]
    print(f"Training load as of {as_of} · metric: {args.metric} ({unit}) · sessions counted: {dict(by_sport)}")
    print()
    dcols = distance_sport is not None
    hdr = (f"{'week of':<11}{'sess':>5}{'hrs':>6}{'ramp':>6}{'load':>8}{'mono':>6}{'strain':>8}{'noRPE':>6}"
           + (f"{distance_sport + ' km':>10}{'long':>6}{'long%':>6}" if dcols else "") + "  by sport")
    print(hdr)
    print("-" * len(hdr))
    for r in table:
        flag = "*" if r["partial"] else " "
        ramp = f"{int(r['ramp_pct']):+d}%" if r["ramp_pct"] is not None else "-"
        mono = f"{r['monotony']:.2f}" if r["monotony"] is not None else "-"
        strain = f"{int(r['strain'])}" if r["strain"] is not None else "-"
        line = (f"{r['week_start']:<10}{flag}{r['sessions']:>5}{r['time_h']:>6.1f}{ramp:>6}{int(r['load']):>8}{mono:>6}{strain:>8}"
                f"{r['sessions_missing_rpe']:>6}")
        if dcols:
            share = f"{int(r['long_share'] * 100)}%" if r["long_share"] is not None else "-"
            line += f"{r['distance_km']:>10.1f}{r['longest_km']:>6.1f}{share:>6}"
        line += "  " + (", ".join(f"{s} {n}" for s, n in sorted(r["by_sport"].items())) or "-")
        print(line)
    print("(* = current, partial week: monotony, strain and ramp not computed. ramp = training hours vs the previous full week;"
          " sessions without a duration add nothing to hours)")
    print()
    print(f"Acute (7 d) mean daily load: {ratios['acute_daily_mean']}   Chronic (28 d) mean daily load: {ratios['chronic_daily_mean_28d']}")
    print(f"Acute:chronic  rolling/coupled: {ratios['ratio_rolling_coupled']}   rolling/uncoupled: {ratios['ratio_rolling_uncoupled']}   EWMA: {ratios['ratio_ewma']}")
    if not ratios["window_full"]:
        print(f"WARNING: only {ratios['history_days']} days of history; the chronic window isn't full, so these ratios are unreliable.")
    if args.metric == "srpe":
        if missing:
            print(f"WARNING: {len(missing)} session(s) have no RPE or duration and contribute nothing to load. Most recent:")
            for a in missing[-5:]:
                print(f"  - {a['date']}  {a['title'] or a['sport']}  ({a['id']})")
            print("  Ask the athlete for RPE on the ones that matter, or use --metric time for a gap-free view.")
        if imputed:
            print(f"WHAT-IF: {len(imputed)} session(s) had RPE imputed as {args.impute_rpe}; treat those numbers as illustrative only.")
    print()
    print(CAVEATS)
    return 0


if __name__ == "__main__":
    sys.exit(main())
