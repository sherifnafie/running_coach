#!/usr/bin/env python3
"""Convert a GPX track to normalized activity JSON (standard library only; gpxpy is not needed).

Output (stdout) is one JSON object:
  {"format": "gpx", "file": ..., "activities": [ {started_at_utc, started_at?, sport, distance_m, duration_s,
   moving_s, elev_gain_m, avg_hr, max_hr, avg_cadence_spm, avg_pace_s_km, laps (per-km splits), title, extra} ],
   "warnings": [...] }
Keys line up with the `activities` table in coach.db. Nothing is invented: anything the file doesn't contain is null.

What to know (full notes in the file-import skill):
  * GPX stores UTC. Pass --tz (the athlete's IANA zone) to also get a local `started_at` with offset.
  * Distance is summed GPS point-to-point (haversine), so it differs from a watch's own distance by ~0.5-2%.
  * Elevation gain uses smoothing plus a hysteresis threshold (--elev-threshold, default 3 m); GPS elevation is
    noisy and other apps will disagree with this number.
  * Moving time counts only steps faster than 0.5 m/s with gaps under 60 s; the rest is paused time.
  * HR and cadence come from the Garmin TrackPointExtension (hr, cad) if present. Garmin 'cad' for running is
    usually one foot (strides/min); values under 120 are doubled to steps/min and flagged in `extra`.

Examples:
    gpx_to_json.py run.gpx --tz Europe/Amsterdam
    gpx_to_json.py run.gpx --records --every 10 > run.json
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

SPORT_WORDS = {"running": "run", "run": "run", "trail_running": "run", "trail running": "run", "treadmill_running": "run",
               "walking": "walk", "walk": "walk", "hiking": "hike", "hike": "hike",
               "cycling": "bike", "biking": "bike", "bike": "bike", "ride": "bike", "swimming": "swim", "swim": "swim"}


def local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_time(s: str | None):
    if not s:
        return None
    s = s.strip().replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def haversine(lat1, lon1, lat2, lon2) -> float:
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def smooth(vals: list[float], k: int = 5) -> list[float]:
    if len(vals) < k:
        return vals[:]
    half = k // 2
    out = []
    for i in range(len(vals)):
        lo, hi = max(0, i - half), min(len(vals), i + half + 1)
        out.append(sum(vals[lo:hi]) / (hi - lo))
    return out


def elevation_gain(elevs: list[float], threshold: float) -> float | None:
    if len(elevs) < 2:
        return None
    s = smooth(elevs)
    ref, gain = s[0], 0.0
    for e in s[1:]:
        if e - ref > threshold:
            gain += e - ref
            ref = e
        elif ref - e > threshold:
            ref = e
    return gain


def localize(dt_utc: datetime, tz: str | None):
    if not tz:
        return None
    from zoneinfo import ZoneInfo
    return dt_utc.astimezone(ZoneInfo(tz)).isoformat(timespec="seconds")


def child_text(el, name):
    for c in el:
        if local(c.tag) == name and c.text:
            return c.text.strip()
    return None


def ext_values(pt) -> dict:
    out = {}
    for el in pt.iter():
        n = local(el.tag)
        if n in ("hr", "cad", "atemp") and el.text:
            try:
                out[n] = float(el.text)
            except ValueError:
                pass
    return out


def track_to_activity(trk, args, warnings: list[str]) -> dict | None:
    pts = []
    for seg in trk:
        if local(seg.tag) != "trkseg":
            continue
        for pt in seg:
            if local(pt.tag) != "trkpt":
                continue
            try:
                lat, lon = float(pt.get("lat")), float(pt.get("lon"))
            except (TypeError, ValueError):
                continue
            ele = child_text(pt, "ele")
            t = parse_time(child_text(pt, "time"))
            ex = ext_values(pt)
            pts.append({"lat": lat, "lon": lon, "ele": float(ele) if ele not in (None, "") else None, "t": t,
                        "hr": ex.get("hr"), "cad": ex.get("cad"), "temp": ex.get("atemp")})
    if len(pts) < 2:
        warnings.append("track has fewer than 2 points; skipped")
        return None

    timed = all(p["t"] is not None for p in pts)
    if not timed:
        warnings.append("some or all points have no timestamp: this is a route, not a recorded activity; no start time, duration or pace")

    dist, moving = 0.0, 0.0
    jumps = 0
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        d = haversine(a["lat"], a["lon"], b["lat"], b["lon"])
        dist += d
        cum.append(dist)
        if timed:
            dt = (b["t"] - a["t"]).total_seconds()
            if dt > 0:
                v = d / dt
                if v > 12.0:
                    jumps += 1
                if v >= 0.5 and dt <= 60:
                    moving += dt
    if jumps:
        warnings.append(f"{jumps} step(s) implied speeds over 12 m/s: GPS jumps or a non-running activity; distance may be inflated")

    start = pts[0]["t"] if timed else None
    elapsed = (pts[-1]["t"] - pts[0]["t"]).total_seconds() if timed else None
    elevs = [p["ele"] for p in pts if p["ele"] is not None]
    gain = elevation_gain(elevs, args.elev_threshold) if len(elevs) >= 0.9 * len(pts) else None
    if gain is None:
        warnings.append("no usable elevation data")
    hrs = [p["hr"] for p in pts if p["hr"] is not None]
    cads = [p["cad"] for p in pts if p["cad"] is not None]

    sport_raw = (child_text(trk, "type") or "").strip()
    sport = SPORT_WORDS.get(sport_raw.lower()) if sport_raw else None
    if args.sport:
        sport = args.sport
    elif sport is None:
        warnings.append(f"sport unknown (GPX <type> is {sport_raw!r}); decide it yourself or pass --sport")

    avg_cad = None
    extra = {"gps_points": len(pts), "distance_basis": "GPS haversine sum", "pace_basis": "elapsed",
             "elev_threshold_m": args.elev_threshold, "gpx_type": sport_raw or None}
    if cads:
        raw = sum(cads) / len(cads)
        if (sport or "run") == "run" and raw < 120:
            avg_cad = raw * 2
            extra["cadence_note"] = f"raw average {raw:.0f} looks like one-foot strides/min; doubled to steps/min"
        else:
            avg_cad = raw
            extra["cadence_note"] = "raw cadence used as-is"
    temps = [p["temp"] for p in pts if p["temp"] is not None]
    if temps:
        extra["avg_temp_c"] = round(sum(temps) / len(temps), 1)

    # per-km splits
    laps = []
    if timed:
        next_km, start_i = 1000.0, 0
        for i, c in enumerate(cum):
            if c >= next_km or i == len(cum) - 1:
                seg = pts[start_i:i + 1]
                seg_dist = cum[i] - cum[start_i]
                seg_time = (pts[i]["t"] - pts[start_i]["t"]).total_seconds()
                seg_hr = [p["hr"] for p in seg if p["hr"] is not None]
                if seg_dist > 0 and seg_time > 0:
                    lap = {"index": len(laps) + 1, "distance_m": round(seg_dist, 1), "duration_s": round(seg_time, 1),
                           "avg_pace_s_km": round(seg_time / (seg_dist / 1000.0), 1)}
                    if seg_hr:
                        lap["avg_hr"] = round(sum(seg_hr) / len(seg_hr), 1)
                    if seg_dist < 950:
                        lap["partial"] = True
                    laps.append(lap)
                start_i = i
                next_km = cum[i] + 1000.0
    act = {
        "started_at_utc": start.astimezone(timezone.utc).isoformat(timespec="seconds") if start else None,
        "started_at": localize(start, args.tz) if start else None,
        "sport": sport,
        "title": child_text(trk, "name"),
        "distance_m": round(dist, 1),
        "duration_s": round(elapsed, 1) if elapsed is not None else None,
        "moving_s": round(moving, 1) if timed else None,
        "elev_gain_m": round(gain, 1) if gain is not None else None,
        "avg_hr": round(sum(hrs) / len(hrs), 1) if hrs else None,
        "max_hr": max(hrs) if hrs else None,
        "avg_cadence_spm": round(avg_cad, 1) if avg_cad is not None else None,
        "avg_pace_s_km": round(elapsed / (dist / 1000.0), 1) if elapsed and dist > 0 else None,
        "laps": laps or None,
        "extra": extra,
    }
    if args.records:
        every = max(1, args.every)
        act["records"] = [
            {"t": p["t"].astimezone(timezone.utc).isoformat(timespec="seconds") if p["t"] else None,
             "lat": round(p["lat"], 6), "lon": round(p["lon"], 6), "ele": p["ele"], "hr": p["hr"], "cad": p["cad"],
             "dist_m": round(cum[i], 1)} for i, p in enumerate(pts) if i % every == 0]
    return act


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="path to a .gpx file")
    ap.add_argument("--tz", help="athlete IANA time zone (e.g. Europe/Amsterdam) to add a local started_at")
    ap.add_argument("--sport", choices=["run", "walk", "hike", "bike", "swim", "other"], help="override the sport")
    ap.add_argument("--elev-threshold", type=float, default=3.0, help="elevation hysteresis in metres (default 3)")
    ap.add_argument("--records", action="store_true", help="include per-point samples")
    ap.add_argument("--every", type=int, default=10, help="with --records, keep every Nth point (default 10)")
    args = ap.parse_args(argv)

    try:
        root = ET.parse(args.file).getroot()
    except (ET.ParseError, OSError) as e:
        print(f"error: cannot read {args.file} as GPX/XML: {e}", file=sys.stderr)
        return 2
    if local(root.tag) != "gpx":
        print(f"error: root element is <{local(root.tag)}>, not <gpx>. Is this a TCX or another format?", file=sys.stderr)
        return 2
    warnings: list[str] = []
    acts = []
    for trk in root:
        if local(trk.tag) == "trk":
            a = track_to_activity(trk, args, warnings)
            if a:
                acts.append(a)
    if not acts:
        warnings.append("no usable <trk> found (routes <rte> and waypoints are not activities)")
    print(json.dumps({"format": "gpx", "file": args.file, "activities": acts, "warnings": warnings}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
