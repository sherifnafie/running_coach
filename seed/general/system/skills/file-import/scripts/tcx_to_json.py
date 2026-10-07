#!/usr/bin/env python3
"""Convert a Garmin TCX file to normalized activity JSON (standard library only).

Output (stdout): {"format": "tcx", "file": ..., "activities": [ {...} ], "warnings": [...]} with the same activity
keys as gpx_to_json.py / fit_to_json.py (started_at_utc, started_at?, sport, distance_m, duration_s, moving_s,
elev_gain_m, avg_hr, max_hr, avg_cadence_spm, avg_pace_s_km, laps, title, extra). Absent data is null, never guessed.

What to know (full notes in the file-import skill):
  * The Activity <Id> and all trackpoint times are UTC. Pass --tz for a local `started_at` with offset.
  * Laps come straight from <Lap> elements: TotalTimeSeconds (timer time), DistanceMeters, heart rates, cadence.
    `duration_s` is elapsed (first to last trackpoint); `moving_s` is the sum of lap timer times.
  * Strava/Garmin TCX 'RunCadence' is usually one foot (strides/min); values under 120 are doubled and flagged.
  * Sport comes from the Activity Sport attribute: Running, Biking, Other (Other is not guessed).

Examples:
    tcx_to_json.py activity.tcx --tz America/New_York
    tcx_to_json.py activity.tcx --records --every 15
"""
from __future__ import annotations

import argparse
import json
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

SPORTS = {"running": "run", "biking": "bike", "cycling": "bike", "walking": "walk", "hiking": "hike", "swimming": "swim"}


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_time(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def find(el, *names):
    """First descendant path match, namespace-agnostic: find(lap, 'AverageHeartRateBpm', 'Value')."""
    cur = el
    for n in names:
        nxt = None
        for c in cur:
            if local(c.tag) == n:
                nxt = c
                break
        if nxt is None:
            return None
        cur = nxt
    return cur


def num(el, *names):
    n = find(el, *names)
    if n is None or n.text is None:
        return None
    try:
        return float(n.text)
    except ValueError:
        return None


def find_deep(el, name):
    for c in el.iter():
        if local(c.tag) == name and c.text:
            try:
                return float(c.text)
            except ValueError:
                return None
    return None


def smooth(vals, k=5):
    if len(vals) < k:
        return vals[:]
    h = k // 2
    return [sum(vals[max(0, i - h):i + h + 1]) / len(vals[max(0, i - h):i + h + 1]) for i in range(len(vals))]


def elevation_gain(elevs, thr):
    if len(elevs) < 2:
        return None
    s = smooth(elevs)
    ref, gain = s[0], 0.0
    for e in s[1:]:
        if e - ref > thr:
            gain += e - ref
            ref = e
        elif ref - e > thr:
            ref = e
    return gain


def localize(dt, tz):
    if not tz:
        return None
    from zoneinfo import ZoneInfo
    return dt.astimezone(ZoneInfo(tz)).isoformat(timespec="seconds")


def activity_to_json(act, args, warnings):
    sport_raw = act.get("Sport") or ""
    sport = SPORTS.get(sport_raw.lower())
    if args.sport:
        sport = args.sport
    elif sport is None:
        warnings.append(f"sport is {sport_raw!r}; not guessed. Decide it yourself or pass --sport")
    id_el = find(act, "Id")
    start = parse_time(id_el.text if id_el is not None else None)

    laps, all_pts = [], []
    total_dist = total_timer = 0.0
    hr_weighted = hr_time = 0.0
    max_hr = None
    for lap in act:
        if local(lap.tag) != "Lap":
            continue
        lap_start = parse_time(lap.get("StartTime"))
        if start is None and lap_start:
            start = lap_start
        t = num(lap, "TotalTimeSeconds")
        d = num(lap, "DistanceMeters")
        ahr = num(lap, "AverageHeartRateBpm", "Value")
        mhr = num(lap, "MaximumHeartRateBpm", "Value")
        cad_ext = find_deep(lap, "AvgRunCadence")
        entry = {"index": len(laps) + 1, "distance_m": round(d, 1) if d is not None else None,
                 "duration_s": round(t, 1) if t is not None else None}
        if d and t:
            entry["avg_pace_s_km"] = round(t / (d / 1000.0), 1)
        if ahr is not None:
            entry["avg_hr"] = ahr
        if mhr is not None:
            entry["max_hr"] = mhr
        laps.append(entry)
        if d:
            total_dist += d
        if t:
            total_timer += t
        if ahr is not None and t:
            hr_weighted += ahr * t
            hr_time += t
        if mhr is not None:
            max_hr = mhr if max_hr is None else max(max_hr, mhr)
        for tp in lap.iter():
            if local(tp.tag) != "Trackpoint":
                continue
            pt = {"t": parse_time(find(tp, "Time").text if find(tp, "Time") is not None else None),
                  "alt": num(tp, "AltitudeMeters"), "dist": num(tp, "DistanceMeters"),
                  "hr": num(tp, "HeartRateBpm", "Value"), "cad": find_deep(tp, "RunCadence"),
                  "lat": num(tp, "Position", "LatitudeDegrees"), "lon": num(tp, "Position", "LongitudeDegrees")}
            if pt["cad"] is None:
                c = num(tp, "Cadence")  # bike rpm, or run cadence in some exporters
                pt["cad"] = c
            all_pts.append(pt)

    if not laps:
        warnings.append("activity has no <Lap> elements")
        return None
    times = [p["t"] for p in all_pts if p["t"]]
    elapsed = (times[-1] - times[0]).total_seconds() if len(times) >= 2 else None
    if total_dist == 0 and all_pts and all_pts[-1]["dist"]:
        total_dist = all_pts[-1]["dist"]
    hrs = [p["hr"] for p in all_pts if p["hr"] is not None]
    if hr_time:
        avg_hr = hr_weighted / hr_time
    elif hrs:
        avg_hr = sum(hrs) / len(hrs)
    else:
        avg_hr = None
    if max_hr is None and hrs:
        max_hr = max(hrs)
    alts = [p["alt"] for p in all_pts if p["alt"] is not None]
    gain = elevation_gain(alts, args.elev_threshold) if len(alts) >= 0.9 * max(1, len(all_pts)) and alts else None
    cads = [p["cad"] for p in all_pts if p["cad"]]
    extra = {"pace_basis": "elapsed", "elev_threshold_m": args.elev_threshold, "trackpoints": len(all_pts),
             "tcx_sport": sport_raw or None}
    avg_cad = None
    if cads:
        raw = sum(cads) / len(cads)
        if sport == "run" and raw < 120:
            avg_cad = raw * 2
            extra["cadence_note"] = f"raw average {raw:.0f} looks like one-foot strides/min; doubled"
        else:
            avg_cad = raw
            extra["cadence_note"] = "raw cadence used as-is"
    if not all_pts:
        warnings.append("no trackpoints: summary-only activity (laps only)")
    dur = elapsed if elapsed is not None else (total_timer or None)
    a = {
        "started_at_utc": start.astimezone(timezone.utc).isoformat(timespec="seconds") if start else None,
        "started_at": localize(start, args.tz) if start else None,
        "sport": sport, "title": None,
        "distance_m": round(total_dist, 1) if total_dist else None,
        "duration_s": round(dur, 1) if dur else None,
        "moving_s": round(total_timer, 1) if total_timer else None,
        "elev_gain_m": round(gain, 1) if gain is not None else None,
        "avg_hr": round(avg_hr, 1) if avg_hr is not None else None,
        "max_hr": max_hr,
        "avg_cadence_spm": round(avg_cad, 1) if avg_cad is not None else None,
        "avg_pace_s_km": round(dur / (total_dist / 1000.0), 1) if dur and total_dist else None,
        "laps": laps, "extra": extra,
    }
    if args.records:
        every = max(1, args.every)
        a["records"] = [{"t": p["t"].astimezone(timezone.utc).isoformat(timespec="seconds") if p["t"] else None,
                         "lat": p["lat"], "lon": p["lon"], "alt": p["alt"], "hr": p["hr"], "cad": p["cad"],
                         "dist_m": p["dist"]} for i, p in enumerate(all_pts) if i % every == 0]
    return a


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="path to a .tcx file")
    ap.add_argument("--tz", help="athlete IANA time zone to add a local started_at")
    ap.add_argument("--sport", choices=["run", "walk", "hike", "bike", "swim", "other"], help="override the sport")
    ap.add_argument("--elev-threshold", type=float, default=3.0, help="elevation hysteresis in metres (default 3)")
    ap.add_argument("--records", action="store_true", help="include per-trackpoint samples")
    ap.add_argument("--every", type=int, default=10, help="with --records, keep every Nth point (default 10)")
    args = ap.parse_args(argv)
    try:
        root = ET.parse(args.file).getroot()
    except (ET.ParseError, OSError) as e:
        print(f"error: cannot read {args.file} as TCX/XML: {e}", file=sys.stderr)
        return 2
    if local(root.tag) != "TrainingCenterDatabase":
        print(f"error: root element is <{local(root.tag)}>, not <TrainingCenterDatabase>. Is this a GPX or another format?", file=sys.stderr)
        return 2
    warnings: list[str] = []
    acts = []
    for el in root.iter():
        if local(el.tag) == "Activity":
            a = activity_to_json(el, args, warnings)
            if a:
                acts.append(a)
    if not acts:
        warnings.append("no activities found (courses and workouts are not activities)")
    print(json.dumps({"format": "tcx", "file": args.file, "activities": acts, "warnings": warnings}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
