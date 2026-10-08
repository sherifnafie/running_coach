#!/usr/bin/env python3
"""Daniels' VDOT from a race result, training paces, and equivalent race times.

Implements the published Daniels & Gilbert (1979) equations (Daniels' Running Formula):

    VO2(v)   = -4.60 + 0.182258 v + 0.000104 v^2          v in metres per minute
    %VO2max(t) = 0.8 + 0.1894393 e^(-0.012778 t) + 0.2989558 e^(-0.1932605 t)   t in minutes
    VDOT     = VO2(distance / t) / %VO2max(t)

VDOT is a performance index ("effective VO2max"), not a lab measurement. Training paces and
race equivalents derived from it are starting points with real error bars: easy pace
in particular is better judged by effort, and heat, hills and fatigue shift everything.

Examples:
    vdot.py --race 5k 20:00
    vdot.py --race 10k 41:30 --units mi
    vdot.py --race half 1:35:10 --json
    vdot.py --vdot 52
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys

MILE_M = 1609.344
HALF_M = 21097.5
MARATHON_M = 42195.0

NAMED_DISTANCES = {
    "800": 800.0, "800m": 800.0,
    "1500": 1500.0, "1500m": 1500.0, "1.5k": 1500.0,
    "mile": MILE_M, "1mile": MILE_M, "1mi": MILE_M,
    "3k": 3000.0, "3000": 3000.0, "3000m": 3000.0,
    "2mile": 2 * MILE_M, "2mi": 2 * MILE_M,
    "5k": 5000.0, "5000": 5000.0, "5000m": 5000.0,
    "8k": 8000.0,
    "10k": 10000.0, "10000": 10000.0, "10000m": 10000.0,
    "15k": 15000.0,
    "10mile": 10 * MILE_M, "10mi": 10 * MILE_M,
    "20k": 20000.0,
    "half": HALF_M, "hm": HALF_M, "halfmarathon": HALF_M, "half-marathon": HALF_M,
    "marathon": MARATHON_M, "m": MARATHON_M, "fullmarathon": MARATHON_M,
}


# --------------------------------------------------------------------------- core equations

def vo2_at_velocity(v_m_min: float) -> float:
    """Oxygen cost of running at v metres/minute (ml/kg/min)."""
    return -4.60 + 0.182258 * v_m_min + 0.000104 * v_m_min ** 2


def fraction_vo2max(t_min: float) -> float:
    """Fraction of VO2max a runner can sustain for t minutes."""
    return 0.8 + 0.1894393 * math.exp(-0.012778 * t_min) + 0.2989558 * math.exp(-0.1932605 * t_min)


def vdot_from_result(distance_m: float, time_s: float) -> float:
    t_min = time_s / 60.0
    return vo2_at_velocity(distance_m / t_min) / fraction_vo2max(t_min)


def velocity_at_vo2(vo2: float) -> float:
    """Invert VO2(v): metres/minute that cost `vo2` ml/kg/min."""
    a, b, c = 0.000104, 0.182258, -4.60 - vo2
    return (-b + math.sqrt(b * b - 4 * a * c)) / (2 * a)


def time_for_vdot(distance_m: float, vdot: float) -> float:
    """Race time (seconds) over `distance_m` that corresponds to `vdot` (bisection)."""
    lo, hi = distance_m / 12.0, distance_m / 0.6  # 12 m/s .. 0.6 m/s
    for _ in range(200):
        mid = (lo + hi) / 2
        if vdot_from_result(distance_m, mid) > vdot:
            lo = mid  # too fast for this VDOT -> need a longer time
        else:
            hi = mid
    return (lo + hi) / 2


def pace_s_per_km_at_fraction(vdot: float, fraction: float) -> float:
    v = velocity_at_vo2(vdot * fraction)  # m/min
    return 1000.0 / v * 60.0


# --------------------------------------------------------------------------- parsing / formatting

def parse_distance(text: str) -> float:
    s = text.strip().lower().replace(" ", "")
    if s in NAMED_DISTANCES:
        return NAMED_DISTANCES[s]
    m = re.fullmatch(r"([0-9]*\.?[0-9]+)(km|k|m|mi|mile|miles)?", s)
    if not m:
        raise ValueError(f"unrecognised distance {text!r} (try 5k, 10k, half, marathon, 5000, 3.1mi)")
    val, unit = float(m.group(1)), m.group(2)
    if unit in ("km", "k"):
        return val * 1000.0
    if unit in ("mi", "mile", "miles"):
        return val * MILE_M
    if unit == "m":
        return val
    return val * 1000.0 if val < 100 else val  # bare 5 -> 5 km, bare 5000 -> metres


def parse_time(text: str) -> float:
    s = text.strip()
    if re.fullmatch(r"[0-9]+(\.[0-9]+)?", s):
        return float(s)  # bare seconds
    parts = s.split(":")
    if not 2 <= len(parts) <= 3:
        raise ValueError(f"unrecognised time {text!r} (use mm:ss or h:mm:ss)")
    secs = 0.0
    for p in parts:
        secs = secs * 60 + float(p)
    return secs


def fmt_time(seconds: float, tenths: bool = False) -> str:
    seconds = round(seconds, 1 if tenths else 0)
    h = int(seconds // 3600)
    m = int((seconds - h * 3600) // 60)
    s = seconds - h * 3600 - m * 60
    sec = f"{s:04.1f}" if tenths else f"{int(round(s)):02d}"
    return f"{h}:{m:02d}:{sec}" if h else f"{m}:{sec}"


def fmt_pace(sec_per_km: float, units: str) -> str:
    per = sec_per_km * (MILE_M / 1000.0) if units == "mi" else sec_per_km
    per = round(per)
    return f"{per // 60}:{per % 60:02d}/{'mi' if units == 'mi' else 'km'}"


# --------------------------------------------------------------------------- derived tables

def training_paces(vdot: float) -> dict:
    """Daniels-style training paces (seconds per km) for a VDOT.

    E: 59-74% of VO2max (slow end..fast end). T: ~88% (about the pace you could race for an hour).
    I: ~100% (about the pace you could race for 10-12 minutes). M: pace of the equivalent marathon
    performance. R: pace of the equivalent mile performance (short reps, full recovery).
    Daniels' printed tables are rounded and differ from these formulas by a few seconds.
    """
    return {
        "easy_slow_s_km": pace_s_per_km_at_fraction(vdot, 0.59),
        "easy_fast_s_km": pace_s_per_km_at_fraction(vdot, 0.74),
        "marathon_s_km": time_for_vdot(MARATHON_M, vdot) / (MARATHON_M / 1000.0),
        "threshold_s_km": pace_s_per_km_at_fraction(vdot, 0.88),
        "interval_s_km": pace_s_per_km_at_fraction(vdot, 1.00),
        "repetition_s_km": time_for_vdot(MILE_M, vdot) / (MILE_M / 1000.0),
    }


def equivalent_times(vdot: float, distances: list[float]) -> list[dict]:
    out = []
    for d in distances:
        t = time_for_vdot(d, vdot)
        out.append({"distance_m": d, "time_s": t, "pace_s_km": t / (d / 1000.0)})
    return out


DEFAULT_EQUIV = [1500.0, MILE_M, 3000.0, 5000.0, 10000.0, 15000.0, HALF_M, MARATHON_M]


def dist_label(d: float) -> str:
    for name, val in (("1500 m", 1500.0), ("mile", MILE_M), ("3000 m", 3000.0), ("5 km", 5000.0), ("10 km", 10000.0),
                      ("15 km", 15000.0), ("half marathon", HALF_M), ("marathon", MARATHON_M)):
        if abs(d - val) < 1:
            return name
    return f"{d / 1000:.2f} km"


# --------------------------------------------------------------------------- CLI

def build_report(vdot: float, units: str, distances: list[float], source: dict | None) -> dict:
    tp = training_paces(vdot)
    return {
        "vdot": round(vdot, 1),
        "source": source,
        "paces": {k: round(v, 1) for k, v in tp.items()},
        "paces_display": {
            "easy": f"{fmt_pace(tp['easy_slow_s_km'], units)} to {fmt_pace(tp['easy_fast_s_km'], units)}",
            "marathon": fmt_pace(tp["marathon_s_km"], units),
            "threshold": fmt_pace(tp["threshold_s_km"], units),
            "interval": fmt_pace(tp["interval_s_km"], units),
            "repetition": fmt_pace(tp["repetition_s_km"], units),
            "threshold_400m_s": round(tp["threshold_s_km"] * 0.4),
            "interval_400m_s": round(tp["interval_s_km"] * 0.4),
            "repetition_400m_s": round(tp["repetition_s_km"] * 0.4),
        },
        "equivalents": [
            {"label": dist_label(e["distance_m"]), "distance_m": round(e["distance_m"], 1),
             "time": fmt_time(e["time_s"]), "time_s": round(e["time_s"], 1),
             "pace": fmt_pace(e["pace_s_km"], units)}
            for e in equivalent_times(vdot, distances)
        ],
    }


def print_report(rep: dict, units: str) -> None:
    src = rep["source"]
    if src:
        print(f"Result: {dist_label(src['distance_m'])} in {fmt_time(src['time_s'])}  ->  VDOT {rep['vdot']}")
    else:
        print(f"VDOT {rep['vdot']}")
    pd = rep["paces_display"]
    print("\nTraining paces (Daniels' definitions; starting points, not prescriptions):")
    print(f"  Easy        {pd['easy']}   (59-74% VO2max; most easy runs sit mid-range, slow end is fine)")
    print(f"  Marathon    {pd['marathon']}   (pace of the equivalent marathon performance)")
    print(f"  Threshold   {pd['threshold']}   (~88% VO2max, 'comfortably hard'; 400 m = {pd['threshold_400m_s']} s)")
    print(f"  Interval    {pd['interval']}   (~VO2max pace; reps of 3-5 min; 400 m = {pd['interval_400m_s']} s)")
    print(f"  Repetition  {pd['repetition']}   (mile pace; short fast reps, full recovery; 400 m = {pd['repetition_400m_s']} s)")
    print("\nEquivalent performances (if equally trained for each distance):")
    for e in rep["equivalents"]:
        print(f"  {e['label']:<14} {e['time']:>8}   {e['pace']}")
    print("\nCaveats: the marathon and half-marathon lines assume matching endurance training; "
          "predictions from short races usually run optimistic for runners with low weekly volume. "
          "Heat, hills, fatigue and a bad day move a single race result; prefer a recent, honest, "
          "well-paced effort, and re-derive after fitness changes.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--race", nargs=2, metavar=("DISTANCE", "TIME"),
                   help="a race result, e.g. --race 5k 20:00  |  --race half 1:35:10  |  --race 3.1mi 31:00")
    g.add_argument("--vdot", type=float, help="use a VDOT directly (e.g. 49.8)")
    ap.add_argument("--units", choices=["km", "mi"], default="km", help="pace display units (default km)")
    ap.add_argument("--distances", nargs="+", metavar="D",
                    help="distances for the equivalents table (default: 1500, mile, 3k, 5k, 10k, 15k, half, marathon)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    try:
        if args.race:
            d_m = parse_distance(args.race[0])
            t_s = parse_time(args.race[1])
            if d_m <= 0 or t_s <= 0:
                raise ValueError("distance and time must be positive")
            vd = vdot_from_result(d_m, t_s)
            source = {"distance_m": d_m, "time_s": t_s}
        else:
            vd = args.vdot
            source = None
        dists = [parse_distance(x) for x in args.distances] if args.distances else DEFAULT_EQUIV
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    if not 15 <= vd <= 90:
        print(f"warning: VDOT {vd:.1f} is outside the usual 15-90 range; check the inputs.", file=sys.stderr)

    rep = build_report(vd, args.units, dists, source)
    if args.json:
        print(json.dumps(rep, indent=2))
    else:
        print_report(rep, args.units)
    return 0


if __name__ == "__main__":
    sys.exit(main())
