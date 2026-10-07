#!/usr/bin/env python3
"""Integrity and hygiene checks for coach.db (read-only).

Reports, with severity, things that usually deserve a look:
  - likely duplicate activities (close start time + similar distance/duration) and shared source blobs
  - missing provenance (source_refs, extracted_by, confidence) on derived rows
  - unconfirmed or low-confidence extractions
  - implausible values (pace, HR, cadence, duration, distance; reps, loads and RPE of lifting sets),
    timestamps without a UTC offset
  - orphaned references (planned_id, block_id, activity_gear, exercise_sets.activity_id, source blobs
    that don't exist in /raw)
  - recent sessions with no RPE or no duration; past planned workouts never resolved
  - schema drift: tables/columns in the database that data/schema.md never mentions

It only reports; it never edits. Fixing is your judgment call (see the data-hygiene skill).

Check a prospective new activity BEFORE inserting it:
    check_db.py --candidate '{"started_at":"2026-10-07T06:58:00+02:00","distance_m":10400,"duration_s":3300}'

Examples:
    check_db.py --as-of 2026-10-07
    check_db.py --as-of 2026-10-07 --raw /raw --schema-md /workspace/data/schema.md
    check_db.py --json
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sqlite3
import sys
from datetime import date, datetime, timedelta, timezone

OFFSET_RE = re.compile(r"(Z|[+-]\d{2}:?\d{2})$")


def parse_ts(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else None


def close(a, b, rel):
    if a is None or b is None:
        return None  # unknown
    if a == b:
        return True
    m = max(abs(a), abs(b))
    return abs(a - b) / m <= rel if m else True


def is_dup(a: dict, b: dict, minutes: float, dist_rel: float, dur_rel: float):
    """Return a human reason if a and b look like the same workout, else None."""
    ta, tb = parse_ts(a.get("started_at")), parse_ts(b.get("started_at"))
    if not ta or not tb:
        return None
    gap = abs((ta - tb).total_seconds()) / 60.0
    if gap > minutes:
        return None
    sa, sb = a.get("sport"), b.get("sport")
    if sa and sb and str(sa).lower() != str(sb).lower():
        return None  # a run and a lift at the same time are two sessions (or a brick), not a duplicate
    dist = close(a.get("distance_m"), b.get("distance_m"), dist_rel)
    dur = close(a.get("duration_s"), b.get("duration_s"), dur_rel)
    if dist is False or dur is False:
        return None
    if dist is None and dur is None:
        return f"starts {gap:.0f} min apart; no distance or duration to compare"
    return f"starts {gap:.0f} min apart; distance {'matches' if dist else 'unknown'}, duration {'matches' if dur else 'unknown'}"


def loads_json(v, default):
    if v is None:
        return default
    try:
        return json.loads(v) if isinstance(v, str) else v
    except ValueError:
        return default


class Report:
    def __init__(self):
        self.items = []

    def add(self, sev, check, msg, ids=None):
        self.items.append({"severity": sev, "check": check, "message": msg, "ids": ids or []})


def run_checks(con, args) -> Report:
    rep = Report()
    cols = lambda t: [r[1] for r in con.execute(f"PRAGMA table_info({t})")]
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    acts = [dict(r) for r in con.execute("SELECT * FROM activities ORDER BY started_at")] if "activities" in tables else []
    as_of = date.fromisoformat(args.as_of) if args.as_of else None

    # --- timestamps
    for a in acts:
        if not a["started_at"] or not OFFSET_RE.search(a["started_at"]) or parse_ts(a["started_at"]) is None:
            rep.add("error", "timestamp", f"{a['id']}: started_at {a['started_at']!r} lacks a UTC offset or is unparseable", [a["id"]])

    # --- duplicates
    dup_pairs = []
    for i, a in enumerate(acts):
        for b in acts[i + 1:]:
            ta, tb = parse_ts(a["started_at"]), parse_ts(b["started_at"])
            if ta and tb and (tb - ta).total_seconds() / 60.0 > args.dup_minutes:
                break  # sorted by started_at (string order is chronological for a fixed offset; good enough here)
            why = is_dup(a, b, args.dup_minutes, 0.03, 0.06)
            if why:
                dup_pairs.append((a["id"], b["id"], why))
    for x, y, why in dup_pairs:
        rep.add("warn", "duplicate", f"{x} and {y} look like the same workout ({why})", [x, y])
    blob_owner: dict[str, list[str]] = {}
    for a in acts:
        for h in loads_json(a["source_refs"], []):
            blob_owner.setdefault(h, []).append(a["id"])
    for h, owners in blob_owner.items():
        if len(set(owners)) > 1:
            rep.add("info", "shared_blob", f"blob {h[:12]}... is a source for several activities ({', '.join(sorted(set(owners)))}); fine for multi-screen merges, otherwise a duplicate", sorted(set(owners)))

    # --- provenance & confirmation
    for a in acts:
        refs = loads_json(a["source_refs"], [])
        if a["source"] in ("screenshot", "file", "sync") and not refs:
            rep.add("error", "provenance", f"{a['id']}: source={a['source']} but source_refs is empty", [a["id"]])
        if a["source"] != "manual" and not a.get("extracted_by"):
            rep.add("warn", "provenance", f"{a['id']}: no extracted_by", [a["id"]])
        if a["source"] != "manual" and a.get("confidence") is None:
            rep.add("warn", "provenance", f"{a['id']}: no confidence recorded", [a["id"]])
        if not a.get("confirmed") and a.get("confidence") is not None and a["confidence"] < args.min_confidence:
            rep.add("warn", "unconfirmed", f"{a['id']} ({a['started_at'][:10]}): confidence {a['confidence']:.2f} and not confirmed by the athlete", [a["id"]])

    # --- plausibility
    for a in acts:
        d, t = a.get("distance_m"), a.get("duration_s")
        if a["sport"] == "run" and d and t and d > 1000:
            pace = t / (d / 1000.0)
            if pace < 150 or pace > 900:
                rep.add("warn", "plausibility", f"{a['id']}: pace {int(pace // 60)}:{int(pace % 60):02d}/km looks implausible (unit or digit error?)", [a["id"]])
        if a.get("avg_hr") and not 30 <= a["avg_hr"] <= 215:
            rep.add("warn", "plausibility", f"{a['id']}: avg_hr {a['avg_hr']}", [a["id"]])
        if a.get("max_hr") and not 40 <= a["max_hr"] <= 230:
            rep.add("warn", "plausibility", f"{a['id']}: max_hr {a['max_hr']}", [a["id"]])
        if a.get("avg_hr") and a.get("max_hr") and a["avg_hr"] > a["max_hr"]:
            rep.add("error", "plausibility", f"{a['id']}: avg_hr above max_hr", [a["id"]])
        if a.get("avg_cadence_spm") and a["sport"] == "run" and not 120 <= a["avg_cadence_spm"] <= 230:
            rep.add("info", "plausibility", f"{a['id']}: running cadence {a['avg_cadence_spm']} spm (one-foot strides? ~85 means double it)", [a["id"]])
        if t and t > 86400:
            rep.add("warn", "plausibility", f"{a['id']}: duration over 24 h", [a["id"]])
        if a["sport"] == "run" and d and d > 250000:
            rep.add("warn", "plausibility", f"{a['id']}: run distance over 250 km (meters vs km?)", [a["id"]])
        if a["sport"] == "run" and d and 0 < d < 100:
            rep.add("warn", "plausibility", f"{a['id']}: run distance {d} m (km entered as meters?)", [a["id"]])
        if a.get("moving_s") and t and a["moving_s"] > t * 1.01:
            rep.add("warn", "plausibility", f"{a['id']}: moving time exceeds elapsed time", [a["id"]])
        if as_of:
            ta = parse_ts(a["started_at"])
            if ta and ta.date() > as_of + timedelta(days=1):
                rep.add("error", "plausibility", f"{a['id']}: started_at is in the future ({a['started_at']})", [a["id"]])

    # --- lifting sets
    if "exercise_sets" in tables:
        set_cols = cols("exercise_sets")
        for r in con.execute("SELECT * FROM exercise_sets"):
            r = dict(r)
            sid = r["id"]
            if r.get("reps") is not None and not 0 <= r["reps"] <= 100:
                rep.add("warn", "plausibility", f"set {sid} ({r.get('exercise')}): {r['reps']} reps", [sid])
            if r.get("load_kg") is not None and not 0 <= r["load_kg"] <= 500:
                rep.add("warn", "plausibility", f"set {sid} ({r.get('exercise')}): load {r['load_kg']} kg (lb entered as kg? total vs per side?)", [sid])
            if r.get("rpe") is not None and not 1 <= r["rpe"] <= 10:
                rep.add("warn", "plausibility", f"set {sid}: RPE {r['rpe']} outside 1-10", [sid])
            if r.get("rir") is not None and not 0 <= r["rir"] <= 10:
                rep.add("warn", "plausibility", f"set {sid}: RIR {r['rir']} outside 0-10", [sid])
            if "performed_at" in set_cols and (not r.get("performed_at") or not OFFSET_RE.search(str(r["performed_at"]))):
                rep.add("error", "timestamp", f"set {sid}: performed_at {r.get('performed_at')!r} lacks a UTC offset", [sid])
        if "activities" in tables:
            for r in con.execute("SELECT s.id, s.activity_id FROM exercise_sets s LEFT JOIN activities a ON a.id = s.activity_id WHERE a.id IS NULL"):
                rep.add("error", "orphan", f"exercise_sets {r[0]} references missing activity {r[1]}", [r[0]])
        names = [r[0] for r in con.execute("SELECT DISTINCT exercise FROM exercise_sets WHERE exercise IS NOT NULL")]
        folded: dict[str, list[str]] = {}
        for n in names:
            folded.setdefault(re.sub(r"[^a-z0-9]", "", n.lower()), []).append(n)
        for variants in folded.values():
            if len(variants) > 1:
                rep.add("info", "naming", f"exercise names that differ only in spelling or case: {', '.join(sorted(variants))} (progress views group by exact name)")

    # --- RPE and duration gaps
    if as_of:
        recent = [a for a in acts if a["sport"] not in ("walk", "other") and parse_ts(a["started_at"])
                  and 0 <= (as_of - parse_ts(a["started_at"]).date()).days <= args.rpe_days]
        miss = [a for a in recent if a.get("rpe") is None]
        if miss:
            rep.add("info", "rpe", f"{len(miss)} session(s) in the last {args.rpe_days} days have no RPE (ask only if it matters)", [a["id"] for a in miss])
        nodur = [a for a in recent if a.get("duration_s") is None]
        if nodur:
            rep.add("info", "duration", f"{len(nodur)} session(s) in the last {args.rpe_days} days have no duration; weekly time and session-RPE load leave them out", [a["id"] for a in nodur])

    # --- orphans
    if "planned_workouts" in tables and "activities" in tables:
        for r in con.execute("SELECT a.id, a.planned_id FROM activities a LEFT JOIN planned_workouts p ON p.id=a.planned_id WHERE a.planned_id IS NOT NULL AND p.id IS NULL"):
            rep.add("error", "orphan", f"activity {r[0]} references missing planned_workouts {r[1]}", [r[0]])
    if "blocks" in tables and "planned_workouts" in tables:
        for r in con.execute("SELECT w.id, w.block_id FROM planned_workouts w LEFT JOIN blocks b ON b.id=w.block_id WHERE w.block_id IS NOT NULL AND b.id IS NULL"):
            rep.add("error", "orphan", f"planned_workouts {r[0]} references missing block {r[1]}", [r[0]])
    if "activity_gear" in tables:
        for r in con.execute("SELECT ag.activity_id, ag.gear_id FROM activity_gear ag LEFT JOIN activities a ON a.id=ag.activity_id LEFT JOIN gear g ON g.id=ag.gear_id WHERE a.id IS NULL OR g.id IS NULL"):
            rep.add("error", "orphan", f"activity_gear row ({r[0]}, {r[1]}) points at a missing activity or gear", [r[0]])
    if args.raw:
        for h, owners in blob_owner.items():
            if not glob.glob(os.path.join(args.raw, "**", h + "*"), recursive=True):
                rep.add("error", "orphan", f"source blob {h[:12]}... for {', '.join(sorted(set(owners)))} not found under {args.raw}", sorted(set(owners)))

    # --- plan vs reality
    if as_of and "planned_workouts" in tables:
        run_dates = {parse_ts(a["started_at"]).date().isoformat() for a in acts if parse_ts(a["started_at"])}
        stale = [r["id"] for r in con.execute("SELECT id, date, type FROM planned_workouts WHERE status='planned' AND type NOT IN ('rest') AND date < ?", (as_of.isoformat(),))
                 if r["date"] not in run_dates]
        if stale:
            rep.add("warn", "plan", f"{len(stale)} past planned workout(s) still 'planned' with no activity that day: update status (done/partial/skipped) or move them", stale)
        done_none = [r["id"] for r in con.execute("SELECT id, date FROM planned_workouts WHERE status='done'") if r["date"] not in run_dates]
        if done_none:
            rep.add("info", "plan", f"{len(done_none)} planned workout(s) marked done with no activity logged that day (athlete marked it in a view? ask for details)", done_none)

    # --- schema drift
    if args.schema_md and os.path.exists(args.schema_md):
        doc = open(args.schema_md, encoding="utf-8").read()
        for t in tables:
            if f"`{t}`" not in doc and t not in doc:
                rep.add("warn", "schema_doc", f"table {t} is not mentioned in {args.schema_md}")
                continue
            missing = [c for c in cols(t) if f"`{c}`" not in doc and not re.search(rf"\b{re.escape(c)}\b", doc)]
            if missing:
                rep.add("warn", "schema_doc", f"columns of {t} not documented in schema.md: {', '.join(missing)}")
    return rep


def check_candidate(con, cand: dict, args):
    rows = [dict(r) for r in con.execute("SELECT * FROM activities")]
    hits = []
    for r in rows:
        why = is_dup(cand, r, args.dup_minutes, 0.03, 0.06)
        if why:
            hits.append({"id": r["id"], "started_at": r["started_at"], "title": r.get("title"), "why": why,
                         "distance_m": r.get("distance_m"), "duration_s": r.get("duration_s")})
    shared = []
    refs = set(cand.get("source_refs", []) or [])
    if refs:
        for r in rows:
            if refs & set(loads_json(r["source_refs"], [])):
                shared.append(r["id"])
    return {"possible_duplicates": hits, "activities_sharing_a_source_blob": shared}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default="/workspace/data/coach.db", help="path to coach.db (default /workspace/data/coach.db)")
    ap.add_argument("--as-of", help="today's local date YYYY-MM-DD from the situation report (enables date-relative checks)")
    ap.add_argument("--raw", help="path to the raw store (e.g. /raw) to verify source blobs exist")
    ap.add_argument("--schema-md", default="/workspace/data/schema.md", help="schema doc to compare against (default /workspace/data/schema.md)")
    ap.add_argument("--candidate", help="JSON of a prospective activity; reports possible duplicates and exits")
    ap.add_argument("--dup-minutes", type=float, default=15.0, help="max start-time gap for duplicate detection (default 15)")
    ap.add_argument("--min-confidence", type=float, default=0.8, help="below this and unconfirmed is flagged (default 0.8)")
    ap.add_argument("--rpe-days", type=int, default=14, help="look-back window for missing RPE (default 14)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    args = ap.parse_args(argv)

    if not os.path.exists(args.db):
        print(f"error: database not found: {args.db}", file=sys.stderr)
        return 2
    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        if args.candidate:
            try:
                cand = json.loads(args.candidate)
            except ValueError as e:
                print(f"error: --candidate is not valid JSON ({e})", file=sys.stderr)
                return 2
            res = check_candidate(con, cand, args)
            print(json.dumps(res, indent=2))  # always JSON: it is meant to be read by you, not scrolled past
            return 0
        rep = run_checks(con, args)
    finally:
        con.close()

    if args.json:
        print(json.dumps(rep.items, indent=2))
    else:
        if not rep.items:
            print("No findings.")
        order = {"error": 0, "warn": 1, "info": 2}
        for it in sorted(rep.items, key=lambda x: order[x["severity"]]):
            print(f"[{it['severity'].upper():5}] {it['check']}: {it['message']}")
        counts = {s: sum(1 for i in rep.items if i["severity"] == s) for s in order}
        print(f"\n{counts['error']} error(s), {counts['warn']} warning(s), {counts['info']} note(s)")
    return 1 if any(i["severity"] == "error" for i in rep.items) else 0


if __name__ == "__main__":
    sys.exit(main())
