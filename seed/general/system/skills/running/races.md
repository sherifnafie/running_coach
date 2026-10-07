# Running: races

Part of the `running` skill. The general event timeline, goals, logistics, morning message and debrief are in `competition-prep`; this file holds what is specific to running races.

## Race goals
Anchor A/B/C goals to a recent race or hard time trial, `zones-and-paces.md` equivalents (`scripts/vdot.py`), recent long-run quality, and conditions. Equivalent times are optimistic if the athlete is under-prepared for the distance, particularly the marathon. First marathon: finishing comfortably is a legitimate A goal. Record in `goal_events` (`kind: race`, `sport: run`, `distance_m`, `goal` with `text` and `time_s`).

## Taper lengths
5K/10K 7 to 10 days; half ~10 to 14 days; marathon 2 to 3 weeks. Cut volume, keep short bursts of intensity (`plan-design.md` §6).

## Pacing
- **Even or slightly negative** effort is generally best for performance over distances from 5K to marathon (Abbiss and Laursen, 2008). Start at or a touch slower than goal pace; the first 10% should feel too easy.
- **The marathon:** many recreational runners slow markedly after ~30 km; large-scale data suggest those who started more conservatively slowed less (Smyth, 2021). "The race starts at 30 km" is a good mantra.
- **Terrain:** pace by effort on hills (steady effort up, relax down); don't "bank time".
- **Heat and wind:** accept slower paces from the start; see the `environment` skill. Set a heat-adjusted goal in advance.
- **A written race plan** (short): target splits or effort bands per section, when to fuel, a mantra, and **if-then rules** ("if the first 5K is >10 s/km too fast, ease back now"; "if my stomach is off, switch to water for 10 minutes").
- Pace bands help some, distract others; ask.

## Fueling and hydration
General guidance is in the `fueling-basics` skill, which also holds the cautions about restriction and energy availability. For races:
- **Practice everything in training.** Nothing new on race day (expert consensus).
- **Before:** for events ≳ 90 minutes, eat a bit more carbohydrate than usual in the final 1 to 2 days (familiar foods, no restricting, no weighing), and a familiar breakfast 2 to 3 hours before. For shorter races, normal eating is fine.
- **During:** for >1 hour, ~30 to 60 g carbohydrate per hour, starting in the first 30 to 45 minutes; up to ~90 g/h in very long events *if* the gut is trained and mixed sugars are used (Jeukendrup, 2014). Start earlier than feels necessary. Sip fluids to thirst at aid stations; **don't overdrink** (exercise-associated hyponatremia is a real, preventable risk; Hew-Butler et al., 2015).
- **Caffeine:** some athletes benefit; only if they already tolerate it. Not for those with anxiety, arrhythmia or sleep issues, and never first time on race day.

## Warm-up
5K/10K, 10 to 15 minutes easy jog, drills, 3 to 4 strides; half and marathon, 5 to 10 minutes easy and strides, then stay warm.

## Recovery after a race
(expert opinion) 5K/10K: 2 to 3 easy or rest days; half: 3 to 7 days easy; marathon: a week or two of easy running and cross-training, then rebuild. Soreness and low energy are normal; persistent pain isn't. Don't plan another hard race too quickly.
After the race, update paces cautiously from the result (`scripts/vdot.py`); a hot or hilly race understates fitness.

## Worked example (10 days before a half marathon, goal 1:55 / B 1:58)
- Last quality: 6 × 1 km at ~threshold nine days out. Long run 14 km a week out at easy-to-steady effort with 3 km at goal pace; then volume down 40%.
- Week of: Mon easy 8 km + strides, Tue 6 km with 3 × 2 min at goal pace, Thu 5 km easy + strides, Fri rest, Sat 15-min jog + 3 strides, Sun race.
- Plan: 5:30 first 3 km (goal pace 5:27), settle, gels at 40 and 75 minutes, water at every second station, check at 15 km: if feeling good, pick up; if not, hold.
- Messages: T−3 logistics message with a checklist; T−1 evening: "lay out your kit; early night if you can, but don't worry if you can't sleep"; race morning as above; next afternoon: "How are the legs? Tell me the story."

## Pitfalls
Starting too fast. Overdrinking. Gels or shoes tried for the first time on race day. Paces from a hot or hilly race taken at face value.

## Evidence notes (citations from memory; verify before quoting)
- Taper: *moderate to strong* (Bosquet et al. 2007; Mujika and Padilla 2003).
- Even pacing: *moderate* (Abbiss and Laursen, Sports Med 2008); marathon pacing data: *moderate, observational* (Smyth, PLoS ONE 2021).
- In-race carbohydrate: *strong* for 30 to 60 g/h over 1 to 2.5 h, *moderate* for higher rates with trained gut and mixed sugars (Jeukendrup, Sports Med 2014; Burke et al., J Sports Sci 2011).
- Hyponatremia consensus: *moderate/consensus* (Hew-Butler et al., Clin J Sport Med 2015).
- Caffeine: *strong* for performance, with individual tolerance caveats (Guest et al., J Int Soc Sports Nutr 2021).
- "Nothing new on race day", warm-up routines, recovery durations: *expert opinion*.
