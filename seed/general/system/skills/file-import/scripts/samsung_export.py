#!/usr/bin/env python3
"""Parse the exercise table from a Samsung Health "Download personal data" export into normalized activity JSON.

Input can be the export ZIP, the extracted folder, or one `com.samsung.shealth.exercise.<timestamp>.csv` file.

Format notes (verify against the real file; Samsung changes this between app versions):
  * The CSV's FIRST line is a metadata row (table name, a version number, a row count), NOT the header. The real
    header is line 2. This script finds the header by looking for a `start_time` column in the first lines.
  * Column names carry long prefixes: `com.samsung.health.exercise.start_time`, `...duration`, `...distance`,
    `...mean_heart_rate`. They are shortened to the last part here. Rows often end with a trailing comma.
  * start_time / end_time look like `2026-10-04 05:12:03.000`. They have been UTC in exports seen so far, with the
    athlete's local offset in `time_offset` (e.g. `UTC+0200`, sometimes a number of milliseconds). That is an
    ASSUMPTION: the script reports it and offers --time-basis local, and you should check one session against a
    screenshot or the athlete's memory before trusting any of them.
  * duration is in milliseconds, distance in metres, mean_speed in m/s, calories in kcal.
  * exercise_type is a numeric code. Known here: 1002 running, 1001 walking, 11007 cycling, 13001 hiking,
    14001 swimming, 0 custom/other. Unknown codes are kept raw and the sport is left as 'other'; ask the athlete.
  * The same session can appear twice when two devices (watch and phone) both recorded it: check `deviceuuid`/`pkg_name`
    and dedupe with the data-hygiene skill before inserting.
  * Per-second detail (HR, speed, location) lives in separate JSON files under jsons/; --live adds summary stats
    from `live_data` when it can find the file (best effort).

Examples:
    samsung_export.py samsunghealth_export.zip --tz Europe/Amsterdam --sport run
    samsung_export.py ~/samsunghealth_20261006/ --since 2026-08-01 --list
    samsung_export.py export.zip --table sleep --limit 5        # dump any other table with clean column names
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import re
import sys
import zipfile
from datetime import datetime, timedelta, timezone

TYPE_MAP = {1002: "run", 1001: "walk", 11007: "bike", 13001: "hike", 14001: "swim", 0: "other"}
EXERCISE_RE = re.compile(r"(^|[/\\])com\.samsung\.shealth\.exercise\.\d{8,14}\.csv$")


# --------------------------------------------------------------------------- reading

class Source:
    """Uniform access to a zip, a folder or a single file."""

    def __init__(self, path: str):
        self.path = path
        self.zip = zipfile.ZipFile(path) if os.path.isfile(path) and zipfile.is_zipfile(path) else None
        self.single = path if os.path.isfile(path) and not self.zip else None

    def names(self) -> list[str]:
        if self.zip:
            return [n for n in self.zip.namelist() if not n.endswith("/")]
        if self.single:
            return [self.single]
        out = []
        for root, _d, files in os.walk(self.path):
            for f in files:
                out.append(os.path.join(root, f))
        return out

    def read_text(self, name: str) -> str:
        data = self.zip.read(name) if self.zip else open(name, "rb").read()
        return data.decode("utf-8-sig", errors="replace")


def find_header_index(lines: list[str], hint: str | None) -> int:
    """The header is the line containing `hint`; otherwise the widest of the first 3 lines (the metadata row has ~3 cells)."""
    head = lines[:3]
    if hint:
        for i, l in enumerate(head):
            if hint in l:
                return i
    if not head:
        return 0
    return max(range(len(head)), key=lambda i: head[i].count(","))


def read_table(text: str, hint: str | None = "start_time") -> list[dict]:
    """Parse a Samsung CSV into dict rows with shortened column names (metadata row skipped)."""
    lines = text.splitlines()
    h = find_header_index(lines, hint)
    reader = csv.reader(lines[h:])
    try:
        header = next(reader)
    except StopIteration:
        return []
    short = []
    for col in header:
        col = col.strip()
        m = re.match(r"^com\.samsung\.s?health\.[a-z_.]*?\.([a-z0-9_]+)$", col)
        short.append(m.group(1) if m else col.rsplit(".", 1)[-1])
    rows = []
    for rec in reader:
        if not any(c.strip() for c in rec):
            continue
        row = {}
        for k, v in zip(short, rec):
            if k and v.strip() != "":
                row[k] = v.strip()
        rows.append(row)
    return rows


# --------------------------------------------------------------------------- conversion

def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse_dt(s: str | None):
    if not s:
        return None
    s = s.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def parse_offset(v: str | None):
    """'UTC+0200' | 'UTC-05:00' | '+02:00' | milliseconds | seconds -> seconds east of UTC (or None)."""
    if not v:
        return None
    v = v.strip()
    m = re.fullmatch(r"(?:UTC|GMT)?\s*([+-])(\d{1,2}):?(\d{2})?", v, flags=re.I)
    if m:
        sign = 1 if m.group(1) == "+" else -1
        return sign * (int(m.group(2)) * 3600 + int(m.group(3) or 0) * 60)
    n = to_float(v)
    if n is None:
        return None
    return int(n / 1000) if abs(n) > 86400 else int(n)


def convert(row: dict, args, live_lookup) -> dict:
    start_naive = parse_dt(row.get("start_time"))
    end_naive = parse_dt(row.get("end_time"))
    off = parse_offset(row.get("time_offset"))
    warnings = []
    start_utc = start_local = end_utc = None
    if start_naive:
        if args.time_basis == "utc":
            start_utc = start_naive.replace(tzinfo=timezone.utc)
            end_utc = end_naive.replace(tzinfo=timezone.utc) if end_naive else None
        else:
            if off is None:
                warnings.append("time-basis local but no time_offset: cannot compute UTC")
            else:
                start_utc = (start_naive - timedelta(seconds=off)).replace(tzinfo=timezone.utc)
                end_utc = (end_naive - timedelta(seconds=off)).replace(tzinfo=timezone.utc) if end_naive else None
        if start_utc is not None:
            if args.tz:
                from zoneinfo import ZoneInfo
                start_local = start_utc.astimezone(ZoneInfo(args.tz))
            elif off is not None:
                start_local = start_utc.astimezone(timezone(timedelta(seconds=off)))

    code = to_float(row.get("exercise_type"))
    code_i = int(code) if code is not None else None
    sport = TYPE_MAP.get(code_i, "other") if code_i is not None else None
    dist = to_float(row.get("distance"))
    dur_ms = to_float(row.get("duration"))
    elapsed = (end_utc - start_utc).total_seconds() if (start_utc and end_utc) else None
    moving = dur_ms / 1000.0 if dur_ms is not None else None
    if elapsed is None:
        elapsed, moving_out = moving, None
    else:
        moving_out = moving
    mean_speed = to_float(row.get("mean_speed"))
    extra = {
        "app": "samsung_health_export",
        "samsung_exercise_type": code_i,
        "time_basis_assumption": args.time_basis,
        "raw_start_time": row.get("start_time"), "time_offset": row.get("time_offset"),
        "duration_basis": "elapsed = end_time - start_time; moving_s = Samsung 'duration'" if moving_out is not None else "Samsung 'duration' only",
        "pace_basis": "elapsed",
        "calories_kcal": to_float(row.get("calorie")),
        "min_hr": to_float(row.get("min_heart_rate")),
        "max_speed_m_s": to_float(row.get("max_speed")),
        "altitude_loss_m": to_float(row.get("altitude_loss")),
        "vo2_max": to_float(row.get("vo2_max")),
        "datauuid": row.get("datauuid"), "deviceuuid": row.get("deviceuuid"), "pkg_name": row.get("pkg_name"),
        "moving_pace_s_km": round(1000.0 / mean_speed, 1) if mean_speed and mean_speed > 0 else None,
        "live_data_file": row.get("live_data"), "title_raw": row.get("title") or row.get("custom") or None,
    }
    if code_i is not None and code_i not in TYPE_MAP:
        warnings.append(f"unknown Samsung exercise_type {code_i}; sport left as 'other'")
    if args.raw_columns:
        extra["raw"] = row
    cad = to_float(row.get("mean_cadence"))
    a = {
        "started_at_utc": start_utc.isoformat(timespec="seconds") if start_utc else None,
        "started_at": start_local.isoformat(timespec="seconds") if start_local else None,
        "utc_offset_s": off,
        "sport": sport,
        "title": row.get("title") or None,
        "distance_m": round(dist, 1) if dist is not None else None,
        "duration_s": round(elapsed, 1) if elapsed is not None else None,
        "moving_s": round(moving_out, 1) if moving_out is not None else None,
        "elev_gain_m": to_float(row.get("altitude_gain")),
        "avg_hr": to_float(row.get("mean_heart_rate")),
        "max_hr": to_float(row.get("max_heart_rate")),
        "avg_cadence_spm": cad,
        "avg_pace_s_km": round(elapsed / (dist / 1000.0), 1) if elapsed and dist else None,
        "laps": None,
        "extra": {k: v for k, v in extra.items() if v is not None},
    }
    if args.live and row.get("live_data"):
        stats = live_lookup(row["live_data"])
        if stats:
            a["extra"]["live_data_summary"] = stats
    if warnings:
        a["warnings"] = warnings
    return a


def make_live_lookup(src: Source):
    names = src.names()

    def lookup(fname: str):
        base = os.path.basename(fname)
        match = next((n for n in names if os.path.basename(n) == base or os.path.basename(n).endswith(base)), None)
        if not match:
            return None
        try:
            data = json.loads(src.read_text(match))
        except ValueError:
            return None
        if not isinstance(data, list) or not data:
            return None
        hrs = [d.get("heart_rate") for d in data if isinstance(d, dict) and isinstance(d.get("heart_rate"), (int, float)) and d.get("heart_rate") > 0]
        out = {"samples": len(data)}
        if hrs:
            out.update({"hr_samples": len(hrs), "hr_mean": round(sum(hrs) / len(hrs), 1), "hr_min": min(hrs), "hr_max": max(hrs)})
        return out
    return lookup


# --------------------------------------------------------------------------- CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("path", help="Samsung Health export ZIP, extracted folder, or an exercise CSV")
    ap.add_argument("--tz", help="athlete IANA time zone: local started_at is computed with it instead of time_offset")
    ap.add_argument("--time-basis", choices=["utc", "local"], default="utc",
                    help="are start_time/end_time UTC (default) or already local? Verify on one known session")
    ap.add_argument("--sport", choices=["run", "walk", "hike", "bike", "swim", "other"], help="keep only this sport")
    ap.add_argument("--since", help="only sessions starting on/after this date (YYYY-MM-DD)")
    ap.add_argument("--until", help="only sessions starting on/before this date (YYYY-MM-DD)")
    ap.add_argument("--list", action="store_true", help="print a compact table instead of JSON")
    ap.add_argument("--live", action="store_true", help="add HR summary from the per-exercise live_data JSON (best effort)")
    ap.add_argument("--raw-columns", action="store_true", help="include every raw CSV column in extra.raw")
    ap.add_argument("--table", help="instead of exercises, dump any CSV whose filename contains this text (e.g. sleep, heart_rate)")
    ap.add_argument("--limit", type=int, default=50, help="with --table, max rows (default 50)")
    args = ap.parse_args(argv)

    if not os.path.exists(args.path):
        print(f"error: {args.path} does not exist", file=sys.stderr)
        return 2
    try:
        src = Source(args.path)
    except zipfile.BadZipFile as e:
        print(f"error: bad ZIP: {e}", file=sys.stderr)
        return 2

    if args.table:
        names = [n for n in src.names() if n.lower().endswith(".csv") and args.table.lower() in os.path.basename(n).lower()]
        if not names:
            print(f"error: no CSV with {args.table!r} in its name. Available CSVs:\n  " +
                  "\n  ".join(sorted(os.path.basename(n) for n in src.names() if n.lower().endswith(".csv"))[:60]), file=sys.stderr)
            return 2
        out = []
        for n in names[:3]:
            rows = read_table(src.read_text(n), hint=None)
            out.append({"file": os.path.basename(n), "rows_total": len(rows), "rows": rows[:args.limit]})
        print(json.dumps(out, indent=2))
        return 0

    if src.single:
        files = [src.single]
    else:
        files = [n for n in src.names() if EXERCISE_RE.search(n)]
    if not files:
        print("error: no com.samsung.shealth.exercise.<timestamp>.csv found. Is this the export's top level? "
              "Try --table to see which CSVs exist.", file=sys.stderr)
        return 2

    rows = []
    for n in files:
        rows.extend(read_table(src.read_text(n), hint="start_time"))
    if rows and not any("start_time" in r for r in rows[:5]):
        print("error: could not find a start_time column; the file layout may have changed. "
              "Inspect it with --table exercise and adapt.", file=sys.stderr)
        return 2

    lookup = make_live_lookup(src) if args.live else (lambda _f: None)
    acts = [convert(r, args, lookup) for r in rows]
    acts = [a for a in acts if a["started_at_utc"]]
    if args.sport:
        acts = [a for a in acts if a["sport"] == args.sport]
    key = lambda a: (a["started_at"] or a["started_at_utc"])[:10]
    if args.since:
        acts = [a for a in acts if key(a) >= args.since]
    if args.until:
        acts = [a for a in acts if key(a) <= args.until]
    acts.sort(key=lambda a: a["started_at_utc"])

    warnings = [f"start_time interpreted as {args.time_basis.upper()}: check one session's local start time against a screenshot "
                "or the athlete before importing anything",
                "dedupe against existing activities (and across watch/phone duplicates) before inserting"]
    unknown = sorted({a["extra"].get("samsung_exercise_type") for a in acts if a.get("warnings")} - {None})
    if unknown:
        warnings.append(f"unknown exercise_type codes seen: {unknown}")

    if args.list:
        print(f"{len(acts)} session(s) ({'|'.join(sorted({a['sport'] or '?' for a in acts}))}), start_time basis: {args.time_basis}")
        for a in acts:
            d = a["distance_m"]
            t = a["duration_s"]
            pace = f"{int(a['avg_pace_s_km'] // 60)}:{int(a['avg_pace_s_km'] % 60):02d}/km" if a["avg_pace_s_km"] else "-"
            print(f"{(a['started_at'] or a['started_at_utc'])[:16]}  {a['sport'] or '?':<5} "
                  f"{(d or 0) / 1000:6.2f} km  {int((t or 0) // 60):4d} min  {pace:>9}  HR {a['avg_hr'] or '-'}")
        return 0
    print(json.dumps({"format": "samsung_health_export", "file": args.path, "activities": acts, "warnings": warnings}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
