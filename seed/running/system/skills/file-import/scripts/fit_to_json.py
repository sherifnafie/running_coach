#!/usr/bin/env python3
"""Convert a Garmin/Coros/Polar/Wahoo .FIT activity file to normalized activity JSON.

Uses `fitdecode` when it is installed (full profile, developer fields). If it is not, falls back to a small
built-in decoder (standard library only) that understands the core messages (file_id, activity, session, lap,
record) and skips everything else, including developer fields. The output says which decoder ran.

Output (stdout): {"format": "fit", "decoder": "fitdecode"|"builtin", "file": ..., "activities": [ {...} ], "warnings": [...]}
Activity keys match gpx_to_json.py / tcx_to_json.py: started_at_utc, started_at (only if the file or --tz gives the
offset), utc_offset_s, sport, distance_m, duration_s (elapsed), moving_s (timer), elev_gain_m, avg_hr, max_hr,
avg_cadence_spm, avg_pace_s_km, laps, title, extra. Absent data is null, never guessed.

What to know (full notes in the file-import skill):
  * FIT timestamps are UTC. The `activity` message's local_timestamp, when present, gives the device's local offset.
  * Running cadence in FIT is one foot (strides/min) plus an optional fractional part; steps/min = 2 x that.
  * `enhanced_speed`/`enhanced_altitude` supersede `speed`/`altitude` when present.
  * Treadmill/indoor runs have footpod or accelerometer distance, no GPS track: flagged in `extra`.
  * A file can chain several activities; each session becomes one activity.

Examples:
    fit_to_json.py morning_run.fit --tz Europe/Amsterdam
    fit_to_json.py morning_run.fit --records --every 30
    fit_to_json.py morning_run.fit --force-builtin
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
from datetime import datetime, timedelta, timezone

FIT_EPOCH = datetime(1989, 12, 31, tzinfo=timezone.utc)
SEMICIRCLE = 180.0 / 2 ** 31

SPORT_ENUM = {0: "generic", 1: "running", 2: "cycling", 3: "transition", 4: "fitness_equipment", 5: "swimming",
              10: "training", 11: "walking", 12: "cross_country_skiing", 15: "rowing", 17: "hiking"}
SUBSPORT_ENUM = {0: "generic", 1: "treadmill", 2: "street", 3: "trail", 4: "track", 6: "indoor_cycling",
                 20: "strength_training", 26: "cardio_training"}
SPORT_TO_ACT = {"running": "run", "walking": "walk", "hiking": "hike", "cycling": "bike", "swimming": "swim"}

# ---------------------------------------------------------------- built-in decoder (stdlib)

# base type byte -> (struct code, size, invalid value)
_BASE = {
    0x00: ("B", 1, 0xFF), 0x01: ("b", 1, 0x7F), 0x02: ("B", 1, 0xFF),
    0x83: ("h", 2, 0x7FFF), 0x84: ("H", 2, 0xFFFF), 0x85: ("i", 4, 0x7FFFFFFF), 0x86: ("I", 4, 0xFFFFFFFF),
    0x07: ("s", 1, None), 0x88: ("f", 4, None), 0x89: ("d", 8, None),
    0x0A: ("B", 1, 0x00), 0x8B: ("H", 2, 0x0000), 0x8C: ("I", 4, 0x00000000),
    0x0D: ("B", 1, 0xFF), 0x8E: ("q", 8, 0x7FFFFFFFFFFFFFFF), 0x8F: ("Q", 8, 0xFFFFFFFFFFFFFFFF), 0x90: ("Q", 8, 0),
}

# global message number -> (name, {field number: (name, scale, offset)})
_MESGS = {
    0: ("file_id", {0: ("type", 1, 0), 1: ("manufacturer", 1, 0), 2: ("product", 1, 0), 4: ("time_created", 1, 0)}),
    18: ("session", {253: ("timestamp", 1, 0), 2: ("start_time", 1, 0), 5: ("sport", 1, 0), 6: ("sub_sport", 1, 0),
                     7: ("total_elapsed_time", 1000, 0), 8: ("total_timer_time", 1000, 0), 9: ("total_distance", 100, 0),
                     11: ("total_calories", 1, 0), 14: ("avg_speed", 1000, 0), 15: ("max_speed", 1000, 0),
                     16: ("avg_heart_rate", 1, 0), 17: ("max_heart_rate", 1, 0), 18: ("avg_cadence", 1, 0),
                     19: ("max_cadence", 1, 0), 22: ("total_ascent", 1, 0), 23: ("total_descent", 1, 0),
                     124: ("enhanced_avg_speed", 1000, 0), 125: ("enhanced_max_speed", 1000, 0)}),
    19: ("lap", {253: ("timestamp", 1, 0), 2: ("start_time", 1, 0), 7: ("total_elapsed_time", 1000, 0),
                 8: ("total_timer_time", 1000, 0), 9: ("total_distance", 100, 0), 13: ("avg_speed", 1000, 0),
                 15: ("avg_heart_rate", 1, 0), 16: ("max_heart_rate", 1, 0), 17: ("avg_cadence", 1, 0),
                 21: ("total_ascent", 1, 0), 110: ("enhanced_avg_speed", 1000, 0)}),
    20: ("record", {253: ("timestamp", 1, 0), 0: ("position_lat", 1, 0), 1: ("position_long", 1, 0),
                    2: ("altitude", 5, 500), 3: ("heart_rate", 1, 0), 4: ("cadence", 1, 0), 5: ("distance", 100, 0),
                    6: ("speed", 1000, 0), 13: ("temperature", 1, 0), 73: ("enhanced_speed", 1000, 0),
                    78: ("enhanced_altitude", 5, 500)}),
    34: ("activity", {253: ("timestamp", 1, 0), 0: ("total_timer_time", 1000, 0), 1: ("num_sessions", 1, 0),
                      2: ("type", 1, 0), 5: ("local_timestamp", 1, 0)}),
}


def _value(raw: bytes, base_type: int, endian: str):
    spec = _BASE.get(base_type)
    if spec is None:
        return None
    code, size, invalid = spec
    if code == "s":
        return raw.split(b"\x00", 1)[0].decode("utf-8", "replace") or None
    if len(raw) < size:
        return None
    n = len(raw) // size
    vals = []
    for i in range(n):
        chunk = raw[i * size:(i + 1) * size]
        v = struct.unpack(endian + code, chunk)[0]
        if code in "fd":
            vals.append(None if v != v else v)  # NaN -> None
        elif invalid is not None and v == invalid:
            vals.append(None)
        else:
            vals.append(v)
    if n == 1:
        return vals[0]
    return vals if any(v is not None for v in vals) else None


def decode_builtin(data: bytes):
    """Yield (message_name, {field_name: value}) for the core messages. Raises ValueError on a malformed file."""
    pos = 0
    n_files = 0
    while pos + 12 <= len(data):
        hsize = data[pos]
        if hsize not in (12, 14) or data[pos + 8:pos + 12] != b".FIT":
            if n_files == 0:
                raise ValueError("not a FIT file (missing .FIT header)")
            break
        data_size = struct.unpack_from("<I", data, pos + 4)[0]
        p = pos + hsize
        end = p + data_size
        if end > len(data):
            end = len(data)  # truncated file: decode what is there
        defs: dict[int, tuple] = {}
        last_ts = 0
        while p < end:
            hdr = data[p]
            p += 1
            compressed = bool(hdr & 0x80)
            if compressed:
                local_type = (hdr >> 5) & 0x03
                is_def = False
                has_dev = False
            else:
                is_def = bool(hdr & 0x40)
                has_dev = bool(hdr & 0x20)
                local_type = hdr & 0x0F
            if is_def:
                p += 1  # reserved
                endian = ">" if data[p] == 1 else "<"
                p += 1
                gnum = struct.unpack_from(endian + "H", data, p)[0]
                p += 2
                nf = data[p]
                p += 1
                fields = []
                for _ in range(nf):
                    fields.append((data[p], data[p + 1], data[p + 2]))
                    p += 3
                dev = []
                if has_dev:
                    nd = data[p]
                    p += 1
                    for _ in range(nd):
                        dev.append((data[p], data[p + 1], data[p + 2]))
                        p += 3
                defs[local_type] = (gnum, endian, fields, dev)
                continue
            if local_type not in defs:
                raise ValueError(f"data message with undefined local type {local_type} at byte {p}")
            gnum, endian, fields, dev = defs[local_type]
            raw_vals = {}
            for num, size, bt in fields:
                raw_vals[num] = _value(data[p:p + size], bt, endian)
                p += size
            for _num, size, _idx in dev:
                p += size  # developer fields are skipped by the built-in decoder
            if compressed:
                off = hdr & 0x1F
                ts = (last_ts & ~0x1F) + off
                if off < (last_ts & 0x1F):
                    ts += 0x20
                raw_vals[253] = ts
            if isinstance(raw_vals.get(253), int):
                last_ts = raw_vals[253]
            spec = _MESGS.get(gnum)
            if spec is None:
                continue
            name, fmap = spec
            out = {}
            for num, v in raw_vals.items():
                if num not in fmap or v is None:
                    continue
                fname, scale, offset = fmap[num]
                if isinstance(v, (int, float)) and (scale != 1 or offset):
                    v = v / scale - offset
                if fname in ("timestamp", "start_time", "time_created", "local_timestamp") and isinstance(v, (int, float)):
                    # values below 0x10000000 are device "system time", not a calendar timestamp
                    out[fname] = FIT_EPOCH + timedelta(seconds=v) if v >= 0x10000000 else None
                    if fname == "local_timestamp" and isinstance(v, (int, float)):
                        out["_local_ts_raw"] = v
                    if fname == "timestamp":
                        out["_ts_raw"] = v
                elif fname in ("position_lat", "position_long"):
                    out[fname] = v  # semicircles
                elif fname == "sport":
                    out[fname] = SPORT_ENUM.get(int(v), f"sport_{int(v)}")
                elif fname == "sub_sport":
                    out[fname] = SUBSPORT_ENUM.get(int(v), f"sub_sport_{int(v)}")
                else:
                    out[fname] = v
            yield name, out
        pos = end + 2  # skip CRC
        n_files += 1


def decode_fitdecode(path: str):
    import fitdecode  # noqa: imported lazily by design
    with fitdecode.FitReader(path) as fr:
        for frame in fr:
            if not isinstance(frame, fitdecode.FitDataMessage):
                continue
            if frame.name not in ("file_id", "session", "lap", "record", "activity", "developer_data_id", "field_description"):
                continue
            out = {}
            for f in frame.fields:
                v = f.value
                if v is None:
                    continue
                if isinstance(v, datetime) and v.tzinfo is None:
                    v = v.replace(tzinfo=timezone.utc)
                out[f.name] = v
            if "timestamp" in out and isinstance(out["timestamp"], datetime):
                out["_ts_raw"] = (out["timestamp"] - FIT_EPOCH).total_seconds()
            if "local_timestamp" in out and isinstance(out["local_timestamp"], datetime):
                lt = out["local_timestamp"]
                if lt.tzinfo is None:
                    lt = lt.replace(tzinfo=timezone.utc)
                out["_local_ts_raw"] = (lt - FIT_EPOCH).total_seconds()
            yield frame.name, out


# ---------------------------------------------------------------- normalization

def _pick(d: dict, *names):
    for n in names:
        if d.get(n) is not None:
            return d[n]
    return None


def _iso_utc(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds") if isinstance(dt, datetime) else None


def _localize(dt, offset_s, tz):
    if not isinstance(dt, datetime):
        return None
    if tz:
        from zoneinfo import ZoneInfo
        return dt.astimezone(ZoneInfo(tz)).isoformat(timespec="seconds")
    if offset_s is not None:
        return dt.astimezone(timezone(timedelta(seconds=offset_s))).isoformat(timespec="seconds")
    return None


def _smooth(vals, k=5):
    if len(vals) < k:
        return vals[:]
    h = k // 2
    return [sum(vals[max(0, i - h):i + h + 1]) / len(vals[max(0, i - h):i + h + 1]) for i in range(len(vals))]


def _gain(elevs, thr):
    if len(elevs) < 2:
        return None
    s = _smooth(elevs)
    ref, g = s[0], 0.0
    for e in s[1:]:
        if e - ref > thr:
            g += e - ref
            ref = e
        elif ref - e > thr:
            ref = e
    return g


def normalize(msgs, args, warnings):
    sessions = [m for n, m in msgs if n == "session"]
    laps = [m for n, m in msgs if n == "lap"]
    records = [m for n, m in msgs if n == "record"]
    activity_msgs = [m for n, m in msgs if n == "activity"]
    file_id = next((m for n, m in msgs if n == "file_id"), {})

    offset_s = None
    for am in activity_msgs:
        if "_local_ts_raw" in am and "_ts_raw" in am:
            diff = am["_local_ts_raw"] - am["_ts_raw"]
            offset_s = int(round(diff / 900.0) * 900)  # offsets are multiples of 15 min
            break
    if file_id.get("type") not in (None, "activity", 4):
        warnings.append(f"file_id type is {file_id.get('type')!r}; expected 'activity'. It may be a workout, course or monitoring file")
    if not sessions:
        warnings.append("no session message found: not a completed activity (or truncated). Nothing to import")
        return []

    acts = []
    for s in sessions:
        start = s.get("start_time")
        elapsed = s.get("total_elapsed_time")
        end = start + timedelta(seconds=elapsed) if isinstance(start, datetime) and elapsed else None
        in_s = lambda m: (isinstance(m.get("timestamp"), datetime) and isinstance(start, datetime) and end is not None
                          and start - timedelta(seconds=2) <= m["timestamp"] <= end + timedelta(seconds=2))
        s_recs = [r for r in records if in_s(r)] if end else records
        s_laps = [l for l in laps if isinstance(l.get("start_time"), datetime) and isinstance(start, datetime) and end is not None
                  and start - timedelta(seconds=2) <= l["start_time"] <= end + timedelta(seconds=2)] if end else laps

        sport_raw = s.get("sport")
        sub = s.get("sub_sport")
        sport = SPORT_TO_ACT.get(sport_raw) if sport_raw else None
        if sport is None and sport_raw == "training":
            sport = "strength" if sub == "strength_training" else "other"
        if sport is None and sport_raw:
            sport = "other"
        if args.sport:
            sport = args.sport
        dist = s.get("total_distance")
        hr_avg, hr_max = s.get("avg_heart_rate"), s.get("max_heart_rate")
        hrs = [r["heart_rate"] for r in s_recs if r.get("heart_rate") is not None]
        if hr_avg is None and hrs:
            hr_avg = sum(hrs) / len(hrs)
        if hr_max is None and hrs:
            hr_max = max(hrs)
        elevs = [_pick(r, "enhanced_altitude", "altitude") for r in s_recs]
        elevs = [e for e in elevs if e is not None]
        gain = s.get("total_ascent")
        gain_basis = "device total_ascent"
        if gain is None and len(elevs) >= 10:
            gain = _gain(elevs, args.elev_threshold)
            gain_basis = f"computed from records (hysteresis {args.elev_threshold} m)"
        cad = s.get("avg_cadence")
        extra = {"fit_sport": sport_raw, "fit_sub_sport": sub, "pace_basis": "elapsed",
                 "elev_basis": gain_basis if gain is not None else None,
                 "manufacturer": file_id.get("manufacturer"), "product": file_id.get("product"),
                 "records": len(s_recs), "laps_in_file": len(s_laps)}
        avg_cad = None
        if cad is not None:
            avg_cad = cad * 2 if sport == "run" else cad
            extra["cadence_note"] = "FIT running cadence is one foot (strides/min); doubled to steps/min" if sport == "run" else "FIT cadence as recorded"
        if sub == "treadmill" or (sport == "run" and records and not any(r.get("position_lat") is not None for r in s_recs)):
            extra["indoor_or_no_gps"] = True
            warnings.append("no GPS track in this session (treadmill/indoor?): distance comes from a footpod or the watch's estimate and is less reliable")
        temps = [r["temperature"] for r in s_recs if r.get("temperature") is not None]
        if temps:
            extra["avg_temp_c"] = round(sum(temps) / len(temps), 1)
        lap_out = []
        for i, l in enumerate(s_laps, 1):
            ld, lt = l.get("total_distance"), l.get("total_elapsed_time")
            lo = {"index": i, "distance_m": round(ld, 1) if ld is not None else None,
                  "duration_s": round(lt, 1) if lt is not None else None}
            if ld and lt:
                lo["avg_pace_s_km"] = round(lt / (ld / 1000.0), 1)
            if l.get("avg_heart_rate") is not None:
                lo["avg_hr"] = l["avg_heart_rate"]
            if l.get("max_heart_rate") is not None:
                lo["max_hr"] = l["max_heart_rate"]
            if l.get("avg_cadence") is not None:
                lo["avg_cadence_spm"] = l["avg_cadence"] * 2 if sport == "run" else l["avg_cadence"]
            lap_out.append(lo)
        a = {
            "started_at_utc": _iso_utc(start),
            "started_at": _localize(start, offset_s, args.tz),
            "utc_offset_s": offset_s,
            "sport": sport, "title": None,
            "distance_m": round(dist, 1) if dist is not None else None,
            "duration_s": round(elapsed, 1) if elapsed else None,
            "moving_s": round(s["total_timer_time"], 1) if s.get("total_timer_time") else None,
            "elev_gain_m": round(gain, 1) if gain is not None else None,
            "avg_hr": round(hr_avg, 1) if hr_avg is not None else None,
            "max_hr": hr_max,
            "avg_cadence_spm": round(avg_cad, 1) if avg_cad is not None else None,
            "avg_pace_s_km": round(elapsed / (dist / 1000.0), 1) if elapsed and dist else None,
            "laps": lap_out or None, "extra": extra,
        }
        if a["started_at"] is None:
            warnings.append("no timezone info in the file: only started_at_utc is set. Convert with the athlete's zone for that date (or pass --tz)")
        if args.records:
            every = max(1, args.every)
            a["records"] = []
            for i, r in enumerate(s_recs):
                if i % every:
                    continue
                lat, lon = r.get("position_lat"), r.get("position_long")
                a["records"].append({
                    "t": _iso_utc(r.get("timestamp")),
                    "lat": round(lat * SEMICIRCLE, 6) if isinstance(lat, (int, float)) else None,
                    "lon": round(lon * SEMICIRCLE, 6) if isinstance(lon, (int, float)) else None,
                    "alt": _pick(r, "enhanced_altitude", "altitude"), "hr": r.get("heart_rate"),
                    "cad": (r["cadence"] * 2 if sport == "run" else r["cadence"]) if r.get("cadence") is not None else None,
                    "speed_m_s": _pick(r, "enhanced_speed", "speed"), "dist_m": r.get("distance")})
        acts.append(a)
    return acts


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="path to a .fit file")
    ap.add_argument("--tz", help="athlete IANA time zone to add a local started_at (overrides the file's own offset)")
    ap.add_argument("--sport", choices=["run", "walk", "hike", "bike", "swim", "strength", "other"], help="override the sport")
    ap.add_argument("--elev-threshold", type=float, default=3.0, help="hysteresis (m) when elevation is computed from records")
    ap.add_argument("--records", action="store_true", help="include per-record samples")
    ap.add_argument("--every", type=int, default=10, help="with --records, keep every Nth record (default 10)")
    ap.add_argument("--force-builtin", action="store_true", help="use the built-in decoder even if fitdecode is installed")
    args = ap.parse_args(argv)

    warnings: list[str] = []
    decoder = "builtin"
    msgs = None
    if not args.force_builtin:
        try:
            import fitdecode  # noqa: F401
            decoder = "fitdecode"
        except ImportError:
            warnings.append("fitdecode is not installed (pip install fitdecode); used the built-in decoder, which skips developer fields and uncommon messages")
    try:
        if decoder == "fitdecode":
            msgs = list(decode_fitdecode(args.file))
        else:
            with open(args.file, "rb") as f:
                data = f.read()
            msgs = list(decode_builtin(data))
    except OSError as e:
        print(f"error: cannot read {args.file}: {e}", file=sys.stderr)
        return 2
    except (ValueError, struct.error, IndexError) as e:
        print(f"error: could not decode {args.file} as FIT ({decoder} decoder): {e}", file=sys.stderr)
        return 2
    except Exception as e:  # fitdecode raises its own error types
        print(f"error: could not decode {args.file} as FIT ({decoder} decoder): {type(e).__name__}: {e}", file=sys.stderr)
        return 2

    acts = normalize(msgs, args, warnings)
    print(json.dumps({"format": "fit", "decoder": decoder, "file": args.file, "activities": acts, "warnings": warnings}, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
