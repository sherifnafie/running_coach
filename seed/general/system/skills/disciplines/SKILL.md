---
name: disciplines
description: "Take on a sport or training goal, including one without a first-party skill (cycling, swimming, climbing, rowing, team or combat sports, general fitness), and coach several disciplines at once (hybrid running + lifting, triathlon, sport + gym). Covers researching a new discipline, writing a workspace skill for it, adapting the database and views, and scheduling concurrent training. Use at intake, when the athlete adds or drops a discipline, or when planning a week with more than one sport."
---

# Disciplines

You coach whatever the athlete trains for. Some of that is covered by first-party skills (`running`, `strength-training`); much isn't. This skill is how you take on anything else carefully, and how you fit several disciplines into one life and one body.

## 1. Find out what they actually do and want
At intake, or when they say "can you also coach my X?":
- **Which disciplines, ranked.** What matters most, what supports it, what's for fun. "Marathon first, keep my squat" and "powerlifting meet in March, run twice a week for health" are very different plans built from the same two sports.
- **For each:** experience (years, level, competition history), current typical week, recent best performances or tests, equipment and facilities, coaching or club they already have (don't fight a club coach's sessions; plan around them), goals with dates, and what they enjoy.
- **Where the discipline's own coach should be in charge.** A team sport's practices, a climbing gym's route-setting classes, a swim squad. You coach what they ask you to coach and plan the rest of the week around fixed sessions you don't control.
Record this in `athlete/profile.md` (Disciplines section) and the `## Disciplines` section of `AGENTS.md`, with the `sport` word you'll use for each in the database.

## 2. Taking on a discipline without a first-party skill
Check `/system/skills` and `/workspace/skills` first. If nothing covers it:
1. **Research before prescribing.** Read the `research` skill. A quick lookup is not enough for a new sport: commission a bounded review (`deep-researcher`, or yourself if helpers are unavailable) of: the physiological and technical demands; how training is usually organized (session types, weekly structure, periodization, how intensity is measured and prescribed); typical volumes and progressions by level; common injuries and their warning signs; sport-specific safety rules and what needs in-person instruction; how competition or testing works; what data athletes usually have (apps, devices, logs) and how to read it. Prefer governing bodies, coaching-education material, consensus statements and reviews. Note evidence strength.
2. **Write a workspace skill** at `/workspace/skills/<discipline>/SKILL.md` (Agent Skills format: front-matter `name`, and a `description` that says what it covers and when to use it, because the index only shows that). Include: what you learned, with citations and evidence levels; how *you* will prescribe and log it for this athlete; the session types and words you'll use for `planned_workouts.type`; red flags and referral triggers; open questions. Model it on `running` and `strength-training`. Update it as you learn; a skill written in week one should be better by week ten.
3. **Decide what to record.** Most of it fits existing tables: `activities` (sport, duration, RPE, HR, distance), `exercise_sets` for any resistance component, `goal_events` for competitions and tests, `metrics` for things like FTP or critical swim speed, `extra` JSON for occasional details. Add a column or a table (with a migration and `data/schema.md`) only for data you will query or chart: climbing grades per route, rowing splits, swim stroke counts.
4. **Adapt the app** if the athlete would benefit: the seed views already show any sport by time and sessions; add a discipline-specific card or view (best grades over time, FTP trend) with the `ui-kit` skill when there is data to show.
5. **Be honest about limits.** Tell the athlete what you can do well remotely (structure, load management, consistency, conditioning, recovery, logistics) and what needs a person (technique, spotting and safety, skill progressions where a mistake injures). Constitution §10 and §11 apply.

## 3. Coaching several disciplines at once
### Principles
- **One body, one budget.** Recovery is shared. Judge the week by total load (time × RPE across all sessions, `training-load`) as well as per discipline. A new discipline is a load jump even if the old one stays the same.
- **Priorities decide conflicts.** The top-priority discipline gets the best days and freshest legs; supporting work is placed where it costs least. Say this out loud so the athlete knows why.
- **The interference effect is real but smaller than folklore.** Heavy endurance volume can blunt strength and power gains, especially lower-body and especially with running (more than cycling); strength work does not meaningfully harm endurance and usually helps it. In recreational athletes with sensible volumes, both improve together (*moderate*; Wilson et al. 2012; Petré et al. 2021; Murlasits et al. 2018). Manage it with scheduling and volume, not by avoiding either.
- **Separate what you can.** Hard sessions of different disciplines ideally on different days, or at least 6 to 24 hours apart, with the priority session first. Easy endurance and upper-body or technique work are the cheapest to stack.
- **Don't stack hard on hard.** Heavy lower-body lifting the day before a key run, long run, or intervals; intervals the day before a heavy squat or deadlift day; a hard team practice plus a hard lift. Typical patterns: heavy legs after a hard run on the same day (keeping the next day easy), or on a day followed by an easy day.
- **Easy days are easy across all disciplines.** An "easy run day" with a brutal leg session isn't an easy day.

### Weekly templates (starting points, not rules)
- **Runner who lifts to support running** (4 runs, 2 lifts): Mon lift A (full body, moderate); Tue quality run; Wed easy run; Thu lift B after an easy run or alone; Sat easy; Sun long run. Detail: `strength-training/support-strength.md`.
- **Lifter who runs for health or conditioning** (3 to 4 lifts, 2 to 3 runs): runs easy, short to moderate, on non-leg days or after upper-body sessions; one optional faster session away from heavy squat and deadlift days. Detail: `strength-training/programming.md` and `running`.
- **Hybrid with two real goals** (e.g. half marathon and a powerlifting total): alternate emphasis by block (a running build with strength at maintenance, then a strength block with running at maintenance), or keep both moderate and accept slower progress in each. Explain the trade-off and let the athlete choose.
- **Team or skill sport plus gym:** practices and matches are fixed; strength goes early in the week away from match day (≥ 48 hours before a match for heavy lower-body work), conditioning fills gaps, and in-season volume drops to maintenance.
- **Triathlon / multi-endurance:** sum time across sports for load; bike and swim are lower-impact than running, so most volume growth can go there; bricks are key sessions.

### Maintenance doses (what keeps a quality while another one is the focus)
Strength and muscle can be maintained for weeks on roughly one-third of previous volume if intensity is kept (one to two sessions a week, a few hard sets per main movement; Spiering et al. 2021; Bickel et al. 2011). Endurance fitness is largely maintained by keeping some intensity with reduced volume over a few weeks (Mujika and Padilla 2000). Use this when a discipline is in a supporting role or during a peak for the other.

### Logging and display
Every session gets its `sport`, so views and scripts can separate and combine them. Set `target_duration_s` on every planned session: weekly time is the common currency. Mark the week's most important sessions with `key = 1`, across all disciplines. One weekly message or plan view, not one per discipline.

## 4. When disciplines change
- **Adding one:** start it conservatively (it's new load), reduce something else if the week was already full, and tell the athlete what you changed to make room.
- **Dropping or pausing one:** keep a maintenance dose if they'll come back to it; record the reason and the last known performances so you can restart sensibly.
- **Off-season and life events:** a discipline's season ending is a good moment to shift emphasis; ask what they want next.
Update `athlete/profile.md`, `AGENTS.md` (Disciplines), `plan/current.md`, `plan/athlete-summary.md` and the views when the mix changes.

## Worked examples
- **"I've been running with you; can you also coach my powerlifting? Meet in 14 weeks."** Ask the meet date, federation and weight class (record it; no cutting advice, §11), recent best lifts, current program and gym days. Re-rank priorities with them (is the half marathon in 10 weeks still the A goal?). Read `strength-training/powerlifting.md`. Propose a combined week, e.g. 3 lifting days and 3 runs (one key run), heavy lower-body away from the long run, running volume held rather than built during the meet peak. Update the profile, schema use (`sport` = `strength`, exercise names), and views.
- **"Coach me for climbing."** No first-party skill. Say you can coach the strength, conditioning, structure and recovery, but not technique or rope safety. Commission research (finger strength and hangboard progressions and their tendon-injury risks, typical bouldering/sport structure, grade systems), write `/workspace/skills/climbing/SKILL.md`, start finger-specific loading very conservatively, add a `grade` key in `activities.extra` or a small `climbs` table if they want to track sends, and maybe a "Hardest sends" card on Progress later.
- **"I just want to get fit."** That's a discipline too: general fitness. Combine easy cardio they enjoy (walking, cycling, running, swimming) with two short full-body strength sessions (`strength-training`), progress gently, and measure by consistency and simple tests they care about.

## Pitfalls
Assuming the first sport mentioned is the only one. Treating each discipline as if the others don't exist. Adding a discipline at full volume. Prescribing technique-critical or dangerous skills remotely. Pretending to expertise you haven't researched. Forgetting to write the workspace skill, so the research is lost. Creating schema for data nobody will look at.

## Evidence notes (citations are from memory; verify before quoting)
- Concurrent training interference: *moderate*; larger for lower-body strength/power with running and high frequency (Wilson et al., J Strength Cond Res 2012; Murlasits et al., J Sports Sci 2018; Petré et al., Sports Med 2021 found little interference on maximal strength in many settings, more on explosive strength).
- Strength training improves endurance performance and economy: *moderate* (Rønnestad and Mujika, Scand J Med Sci Sports 2014; Blagrove et al., Sports Med 2018).
- Maintenance doses: *moderate* (Bickel et al., Med Sci Sports Exerc 2011; Spiering et al., J Strength Cond Res 2021 review; Mujika and Padilla, Sports Med 2000).
- Scheduling order and gaps: *weak to moderate*; mostly acute studies and expert practice.
