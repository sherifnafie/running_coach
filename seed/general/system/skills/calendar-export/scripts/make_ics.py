#!/usr/bin/env python3
"""Generate exports/calendar.ics from planned_workouts (and goal_events, or races in older workspaces) in coach.db.

The file is a subscription feed: calendar apps poll it and replace what they had, so regenerate
the whole file after any plan change (deleted or moved workouts simply disappear).

- UIDs are stable: workout-<planned_workouts.id>@opencoach (event-<goal_events.id>@opencoach, or
  race-<races.id>@opencoach in older workspaces). Never derive a UID
  from the date or title, or moving a session would create a duplicate in the athlete's calendar.
- Timed events use TZID with a generated VTIMEZONE; all-day events (slot 'any'/NULL) use VALUE=DATE.
- DESCRIPTION shows the athlete-facing description, targets and the session structure in words (endurance
  steps and exercises with sets, reps and load).
  `coach_notes` (private rationale) are never exported.
- Standard library only (zoneinfo needs tzdata; if it is missing, use --floating).

Examples:
    make_ics.py --tz Europe/Amsterdam
    make_ics.py --tz America/New_York --am 06:30 --pm 18:00 --units mi --alarm 60
    make_ics.py --floating --db /workspace/data/coach.db --out /workspace/exports/calendar.ics
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import tempfile
from datetime import date, datetime, time, timedelta, timezone

PRODID = "-//OpenCoach//Coach//EN"
UID_DOMAIN = "opencoach"
MILE_M = 1609.344
EXCLUDED_STATUSES = {"skipped", "moved"}


# ------------------------------------------------------------------ text helpers

def esc(text: str) -> str:
    """Escape an iCalendar TEXT value."""
    return (text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")
                .replace("\r\n", "\\n").replace("\n", "\\n").replace("\r", "\\n"))


def fold(line: str) -> str:
    """Fold to <= 75 octets per physical line (RFC 5545 3.1), never splitting a UTF-8 character."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    out, cur, cur_len = [], "", 0
    limit = 75
    for ch in line:
        n = len(ch.encode("utf-8"))
        if cur_len + n > limit:
            out.append(cur)
            cur, cur_len, limit = "", 0, 74  # continuation lines start with a space
        cur += ch
        cur_len += n
    out.append(cur)
    return "\r\n ".join(out)


def fmt_dt_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


# ------------------------------------------------------------------ workout structure in words

def fmt_pace(sec_per_km: float, units: str) -> str:
    v = sec_per_km * (MILE_M / 1000.0) if units == "mi" else sec_per_km
    v = round(v)
    return f"{v // 60}:{v % 60:02d}"


def fmt_dur(d: dict, units: str) -> str:
    if not isinstance(d, dict):
        return ""
    if "time_s" in d:
        s = float(d["time_s"])
        if s >= 120 and abs(s / 60 - round(s / 60)) < 1e-6:
            return f"{int(round(s / 60))} min"
        if s >= 60:
            return f"{int(s // 60)}:{int(s % 60):02d} min"
        return f"{int(s)} s"
    if "distance_m" in d:
        m = float(d["distance_m"])
        if units == "mi":
            mi = m / MILE_M
            return f"{mi:.2f} mi".replace(".00", "")
        if m >= 1000:
            km = m / 1000
            return (f"{km:.1f} km" if abs(km - round(km)) > 1e-6 else f"{int(round(km))} km")
        return f"{int(m)} m"
    return ""


def fmt_range(r, fmt=lambda x: str(x)) -> str:
    if isinstance(r, (list, tuple)) and len(r) == 2:
        a, b = r
        return fmt(a) if a == b else f"{fmt(a)}-{fmt(b)}"
    return fmt(r)


def fmt_target(t: dict | None, units: str) -> str:
    if not t:
        return ""
    parts = []
    if "pace_s_km" in t:
        unit = "/mi" if units == "mi" else "/km"
        r = t["pace_s_km"]
        if isinstance(r, (list, tuple)) and len(r) == 2:
            r = sorted(r)  # faster (smaller) first reads naturally as "3:55-4:05"
        parts.append(fmt_range(r, lambda x: fmt_pace(float(x), units)) + unit)
    if "hr_bpm" in t:
        parts.append(fmt_range(t["hr_bpm"]) + " bpm")
    if "hr_zone" in t:
        parts.append("zone " + fmt_range(t["hr_zone"]))
    if "rpe" in t:
        parts.append("RPE " + fmt_range(t["rpe"]))
    if "rir" in t:
        parts.append(fmt_range(t["rir"]) + " reps in reserve")
    if "pct_1rm" in t:
        parts.append(fmt_range(t["pct_1rm"]) + "% of 1RM")
    if "talk_test" in t:
        parts.append(str(t["talk_test"]))
    return ", ".join(parts)


KIND_LABEL = {"warmup": "Warm-up", "cooldown": "Cool-down", "work": "Work", "recovery": "Recovery", "rest": "Rest",
              "steady": "Steady", "easy": "Easy"}


def fmt_num(x) -> str:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return str(x)
    return str(int(f)) if f == int(f) else f"{f:g}"


def fmt_load(load, load_units: str) -> str:
    if not isinstance(load, dict):
        return ""
    if load.get("bodyweight"):
        return "bodyweight"
    if "kg" in load:
        conv = (lambda x: float(x) * 2.2046226218) if load_units == "lb" else float
        r = load["kg"]
        rr = [conv(v) for v in r] if isinstance(r, (list, tuple)) else conv(r)
        return fmt_range(rr, lambda v: f"{round(float(v) * 2) / 2:g}") + f" {load_units}"
    if "pct_1rm" in load:
        return fmt_range(load["pct_1rm"]) + "% 1RM"
    return ""


def fmt_reps(reps) -> str:
    if isinstance(reps, (list, tuple)) and len(reps) == 2:
        return f"{fmt_num(reps[0])}-{fmt_num(reps[1])}"
    return fmt_num(reps) if reps is not None else ""


def render_exercise(st: dict, units: str, load_units: str) -> str:
    name = str(st.get("name") or "Exercise")
    def one(sets, reps, dur, load, tgt) -> str:
        what = fmt_reps(reps) if reps is not None else fmt_dur(dur or {}, units)
        text = f"{fmt_num(sets)} x {what}" if what else f"{fmt_num(sets)} sets"
        ld = fmt_load(load, load_units)
        if ld:
            text += f" @ {ld}"
        t = fmt_target(tgt, units)
        if t:
            text += f" ({t})"
        return text
    sets = st.get("sets")
    if isinstance(sets, list):
        parts = [one(x.get("times", 1), x.get("reps", st.get("reps")), x.get("duration", st.get("duration")),
                     x.get("load", st.get("load")), x.get("target", st.get("target"))) for x in sets if isinstance(x, dict)]
        body = "; ".join(parts)
    else:
        body = one(sets if sets is not None else 1, st.get("reps"), st.get("duration"), st.get("load"), st.get("target"))
    if st.get("rest_s"):
        body += f", rest {fmt_dur({'time_s': st['rest_s']}, units)}"
    if st.get("tempo"):
        body += f", tempo {st['tempo']}"
    return f"{name}: {body}"


def render_steps(steps: list, units: str, indent: str = "", load_units: str = "kg") -> list[str]:
    lines = []
    for st in steps or []:
        if not isinstance(st, dict):
            continue
        if st.get("kind") == "exercise":
            lines.append(indent + render_exercise(st, units, load_units))
            if st.get("note"):
                lines.append(f"{indent}  ({st['note']})")
            continue
        if st.get("kind") == "repeat":
            lines.append(f"{indent}{st.get('times', '?')} x:")
            lines.extend(render_steps(st.get("steps", []), units, indent + "  ", load_units))
            continue
        label = KIND_LABEL.get(st.get("kind", ""), str(st.get("kind", "Step")).capitalize())
        dur = fmt_dur(st.get("duration", {}), units)
        tgt = fmt_target(st.get("target"), units)
        text = f"{indent}{label}: {dur}".rstrip()
        if tgt:
            text += f" at {tgt}"
        lines.append(text)
    return lines


def describe_workout(row: sqlite3.Row, units: str, load_units: str = "kg") -> str:
    parts = []
    if row["description"]:
        parts.append(row["description"].strip())
    targets = []
    if row["target_distance_m"]:
        targets.append(fmt_dur({"distance_m": row["target_distance_m"]}, units))
    if row["target_duration_s"]:
        targets.append(fmt_dur({"time_s": row["target_duration_s"]}, units))
    if targets:
        parts.append("Target: " + " / ".join(targets))
    notes = None
    if row["structure"]:
        try:
            st = json.loads(row["structure"])
            lines = render_steps(st.get("steps", []), units, load_units=load_units)
            if lines:
                parts.append("\n".join(lines))
            notes = st.get("notes")
        except (ValueError, AttributeError, TypeError):
            pass
    if notes:
        parts.append("Note: " + str(notes))
    return "\n".join(parts)


# ------------------------------------------------------------------ time zones

def build_vtimezone(tzname: str, first_year: int, last_year: int) -> list[str]:
    """Emit a VTIMEZONE with one explicit observance per offset change in [first_year-1, last_year+1]."""
    from zoneinfo import ZoneInfo
    tz = ZoneInfo(tzname)
    start = datetime(first_year - 1, 1, 1, 12, tzinfo=timezone.utc)
    end = datetime(last_year + 1, 12, 31, 12, tzinfo=timezone.utc)

    def off(dt_utc: datetime):
        loc = dt_utc.astimezone(tz)
        return loc.utcoffset(), loc.dst(), loc.tzname()

    def hhmm(td: timedelta) -> str:
        secs = int(td.total_seconds())
        sign = "+" if secs >= 0 else "-"
        secs = abs(secs)
        return f"{sign}{secs // 3600:02d}{(secs % 3600) // 60:02d}"

    lines = ["BEGIN:VTIMEZONE", f"TZID:{tzname}"]
    o0, dst0, name0 = off(start)
    base_start = f"{first_year - 1}0101T000000"
    kind0 = "DAYLIGHT" if dst0 else "STANDARD"
    lines += [f"BEGIN:{kind0}", f"DTSTART:{base_start}", f"TZOFFSETFROM:{hhmm(o0)}", f"TZOFFSETTO:{hhmm(o0)}",
              f"TZNAME:{name0}", f"END:{kind0}"]
    prev = start
    cur = start
    while cur < end:
        nxt = cur + timedelta(days=1)
        if off(nxt)[0] != off(cur)[0]:
            lo, hi = cur, nxt  # transition within (lo, hi]; bisect to the minute
            while (hi - lo) > timedelta(minutes=1):
                mid = lo + (hi - lo) / 2
                if off(mid)[0] == off(cur)[0]:
                    lo = mid
                else:
                    hi = mid
            before = off(lo)
            after = off(hi)
            hi = hi.replace(second=0, microsecond=0)  # transitions fall on whole minutes
            local_before = hi.astimezone(timezone(before[0]))  # wall clock at the change, in the old offset
            kind = "DAYLIGHT" if after[1] else "STANDARD"
            lines += [f"BEGIN:{kind}", f"DTSTART:{local_before.strftime('%Y%m%dT%H%M%S')}",
                      f"TZOFFSETFROM:{hhmm(before[0])}", f"TZOFFSETTO:{hhmm(after[0])}",
                      f"TZNAME:{after[2]}", f"END:{kind}"]
        cur = nxt
    lines.append("END:VTIMEZONE")
    return lines


# ------------------------------------------------------------------ main generation

def parse_hhmm(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def table_exists(con: sqlite3.Connection, name: str) -> bool:
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def build_calendar(args) -> tuple[str, int]:
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    q = "SELECT * FROM planned_workouts WHERE 1=1"
    params: list = []
    if args.date_from:
        q += " AND date >= ?"; params.append(args.date_from)
    if args.date_to:
        q += " AND date <= ?"; params.append(args.date_to)
    q += " ORDER BY date, slot, id"
    workouts = [r for r in con.execute(q, params)
                if r["status"] not in EXCLUDED_STATUSES and (args.include_rest or r["type"] != "rest")]
    races = []
    event_table = "goal_events" if table_exists(con, "goal_events") else "races" if table_exists(con, "races") else None
    if not args.no_events and event_table:
        rq = f"SELECT * FROM {event_table} WHERE 1=1"
        rp: list = []
        if args.date_from:
            rq += " AND date >= ?"; rp.append(args.date_from)
        if args.date_to:
            rq += " AND date <= ?"; rp.append(args.date_to)
        races = list(con.execute(rq + " ORDER BY date", rp))
    con.close()

    # Rows without a parseable updated_at (goal events) borrow the newest workout timestamp, so regenerating
    # an unchanged plan yields a byte-identical file. Only an empty plan falls back to the wall clock.
    stamps = [s for s in (parse_iso(r["updated_at"]) for r in workouts) if s]
    if args.stamp:
        fallback_stamp = parse_iso(args.stamp) or datetime.now(timezone.utc)
    elif stamps:
        fallback_stamp = max(stamps)
    else:
        fallback_stamp = datetime.now(timezone.utc)

    dates = [date.fromisoformat(r["date"]) for r in workouts + races]
    fy, ly = (min(dates).year, max(dates).year) if dates else (fallback_stamp.year, fallback_stamp.year)

    tzid = None
    vtz: list[str] = []
    if not args.floating:
        try:
            vtz = build_vtimezone(args.tz, fy, ly)
            tzid = args.tz
        except Exception as e:  # missing tzdata or unknown zone
            raise SystemExit(f"error: cannot build time zone {args.tz!r} ({e}). Check the IANA name, or pass --floating "
                             f"to emit floating local times (they follow whatever zone the viewer is in).")

    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", f"PRODID:{PRODID}", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
             f"X-WR-CALNAME:{esc(args.name)}"]
    if tzid:
        lines.append(f"X-WR-TIMEZONE:{tzid}")
    lines += ["REFRESH-INTERVAL;VALUE=DURATION:PT6H", "X-PUBLISHED-TTL:PT6H"]
    lines += vtz

    times = {"am": parse_hhmm(args.am), "pm": parse_hhmm(args.pm)}
    n = 0

    def add_event(uid: str, summary: str, d: date, start_t: time | None, dur: timedelta | None,
                  description: str, categories: str, updated: datetime | None, transparent: bool):
        nonlocal n
        stamp = updated or fallback_stamp
        ev = ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{fmt_dt_utc(stamp)}", f"LAST-MODIFIED:{fmt_dt_utc(stamp)}",
              f"SEQUENCE:{int(stamp.timestamp() // 60) % 2147483647}"]
        if start_t is None:
            ev.append(f"DTSTART;VALUE=DATE:{d.strftime('%Y%m%d')}")
            ev.append(f"DTEND;VALUE=DATE:{(d + timedelta(days=1)).strftime('%Y%m%d')}")
        else:
            st = datetime.combine(d, start_t)
            en = st + (dur or timedelta(hours=1))
            if tzid:
                ev.append(f"DTSTART;TZID={tzid}:{st.strftime('%Y%m%dT%H%M%S')}")
                ev.append(f"DTEND;TZID={tzid}:{en.strftime('%Y%m%dT%H%M%S')}")
            else:
                ev.append(f"DTSTART:{st.strftime('%Y%m%dT%H%M%S')}")
                ev.append(f"DTEND:{en.strftime('%Y%m%dT%H%M%S')}")
        ev.append(f"SUMMARY:{esc(summary)}")
        if description:
            ev.append(f"DESCRIPTION:{esc(description)}")
        if categories:
            ev.append(f"CATEGORIES:{esc(categories)}")
        ev.append("STATUS:CONFIRMED")
        ev.append(f"TRANSP:{'TRANSPARENT' if transparent else 'OPAQUE'}")
        if args.alarm and start_t is not None:
            ev += ["BEGIN:VALARM", "ACTION:DISPLAY", f"DESCRIPTION:{esc(summary)}", f"TRIGGER:-PT{int(args.alarm)}M", "END:VALARM"]
        ev.append("END:VEVENT")
        lines.extend(ev)
        n += 1

    for r in workouts:
        d = date.fromisoformat(r["date"])
        slot = (r["slot"] or "any").lower()
        start_t = times.get(slot)
        if start_t is None and args.any_time:
            start_t = parse_hhmm(args.any_time)
        if r["target_duration_s"]:
            dur = timedelta(seconds=float(r["target_duration_s"]))
        elif r["target_distance_m"]:
            dur = timedelta(seconds=float(r["target_distance_m"]) / 1000.0 * args.assume_pace)
        else:
            dur = timedelta(hours=1)
        dur = max(dur, timedelta(minutes=15))
        add_event(f"workout-{r['id']}@{UID_DOMAIN}", r["title"], d, start_t, dur,
                  describe_workout(r, args.units, args.load_units), r["type"], parse_iso(r["updated_at"]),
                  transparent=(start_t is None))
    kind_label = {"race": "Race", "meet": "Meet", "match": "Match", "test": "Test", "trip": "Trip"}
    for r in races:
        d = date.fromisoformat(r["date"])
        keys = r.keys()
        kind = (r["kind"] if "kind" in keys else None) or ("race" if event_table == "races" else None)
        desc_parts = []
        if "distance_m" in keys and r["distance_m"]:
            desc_parts.append("Distance: " + fmt_dur({"distance_m": r["distance_m"]}, args.units))
        if r["priority"]:
            desc_parts.append(f"Priority: {r['priority']}")
        try:
            goal = json.loads(r["goal"]) if r["goal"] else None
            if isinstance(goal, dict) and goal.get("text"):
                desc_parts.append(f"Goal: {goal['text']}")
            elif isinstance(goal, dict) and goal.get("time_s"):
                s = int(goal["time_s"])
                desc_parts.append(f"Goal: {s // 3600}:{(s % 3600) // 60:02d}:{s % 60:02d}")
        except (ValueError, TypeError):
            pass
        label = kind_label.get(str(kind or "").lower())
        uid = f"race-{r['id']}@{UID_DOMAIN}" if event_table == "races" else f"event-{r['id']}@{UID_DOMAIN}"
        add_event(uid, f"{label}: {r['name']}" if label else r["name"], d, None, None, "\n".join(desc_parts), str(kind or "event"),
                  None, transparent=False)

    lines.append("END:VCALENDAR")
    text = "\r\n".join(fold(l) for l in lines) + "\r\n"
    return text, n


def check_ics(text: str) -> list[str]:
    """Minimal structural validation. Returns a list of problems (empty = looks fine)."""
    problems = []
    if "\r\n" not in text:
        problems.append("lines are not CRLF-terminated")
    unfolded = re.sub(r"\r\n[ \t]", "", text).split("\r\n")
    if not unfolded or unfolded[0] != "BEGIN:VCALENDAR":
        problems.append("does not start with BEGIN:VCALENDAR")
    stack = []
    uids = []
    for l in unfolded:
        if l.startswith("BEGIN:"):
            stack.append(l[6:])
        elif l.startswith("END:"):
            if not stack or stack.pop() != l[4:]:
                problems.append(f"unbalanced {l}")
        elif l.startswith("UID:"):
            uids.append(l[4:])
    if stack:
        problems.append(f"unclosed: {stack}")
    if len(uids) != len(set(uids)):
        problems.append("duplicate UIDs")
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="/workspace/data/coach.db", help="coach.db path (default /workspace/data/coach.db)")
    ap.add_argument("--out", default="/workspace/exports/calendar.ics", help="output path (default /workspace/exports/calendar.ics)")
    ap.add_argument("--tz", help="athlete IANA time zone, e.g. Europe/Amsterdam (from the situation report). Required unless --floating")
    ap.add_argument("--floating", action="store_true", help="emit floating local times (no TZID); events follow the viewer's zone")
    ap.add_argument("--name", default="Training", help="calendar name shown in apps (default 'Training')")
    ap.add_argument("--am", default="07:00", help="start time for slot 'am' (default 07:00)")
    ap.add_argument("--pm", default="17:30", help="start time for slot 'pm' (default 17:30)")
    ap.add_argument("--any-time", help="give slot 'any'/NULL workouts a start time (default: all-day events)")
    ap.add_argument("--assume-pace", type=float, default=360.0,
                    help="s/km used only to size an event's duration from target_distance_m (default 360)")
    ap.add_argument("--units", choices=["km", "mi"], default="km", help="distance units in descriptions (default km)")
    ap.add_argument("--load-units", choices=["kg", "lb"], default="kg", help="load units in descriptions (default kg)")
    ap.add_argument("--from", dest="date_from", help="only workouts/events on or after YYYY-MM-DD")
    ap.add_argument("--to", dest="date_to", help="only workouts/events on or before YYYY-MM-DD")
    ap.add_argument("--include-rest", action="store_true", help="also export rest days")
    ap.add_argument("--no-events", "--no-races", dest="no_events", action="store_true", help="don't export goal events (or races)")
    ap.add_argument("--alarm", type=int, metavar="MIN", help="add a display alarm MIN minutes before timed events (off by default)")
    ap.add_argument("--stamp", help="fallback DTSTAMP (ISO) for rows without a parseable updated_at (default: now)")
    ap.add_argument("--check", action="store_true", help="validate the output structure after writing")
    args = ap.parse_args(argv)

    if not args.floating and not args.tz:
        ap.error("--tz is required (or pass --floating)")
    if not os.path.exists(args.db):
        print(f"error: database not found: {args.db}", file=sys.stderr)
        return 2
    try:
        text, n = build_calendar(args)
    except sqlite3.OperationalError as e:
        print(f"error: could not read planned_workouts ({e})", file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(args.out)), suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    os.replace(tmp, args.out)
    print(f"wrote {args.out}: {n} event(s)")
    if args.check:
        problems = check_ics(text)
        if problems:
            print("PROBLEMS: " + "; ".join(problems), file=sys.stderr)
            return 1
        print("structure check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
