---
name: race-prep
description: "Race-specific preparation from about six weeks out through the debrief: goal setting, taper, pacing, fueling and hydration plan, logistics checklist, race-morning message, post-race recovery and debrief. Use when a goal race is on the calendar."
---

# Race preparation

A race is a project with a start, a taper, a day and an afterlife. Your job is to help the athlete arrive healthy, rested, practiced and calm, with a plan they believe in, and then to help them make sense of what happened.

## Timeline (adapt to the distance)
| When | What |
|---|---|
| ~8 to 6 weeks out | Confirm goals (A/B/C); check the course (profile, aid stations, start logistics) via `researcher` or the athlete; start practising race fueling on long runs; choose race-day shoes and kit and use them. |
| ~6 to 3 weeks | Race-specific sessions; one dress rehearsal long run (kit, breakfast, fuel, pace). Book travel; think about weather. |
| Taper (see `plan-design`) | 5K/10K 7 to 10 days; half ~10 to 14 days; marathon 2 to 3 weeks. Cut volume, keep short bursts of intensity. |
| Race week | Light running with strides; sleep; familiar food; logistics; short, calm messages. |
| T−2 to T−1 | Packet pickup, final kit check, bag packed, alarm set, dinner familiar; early night (but expect poor sleep the night before: the night *two* before matters most). |
| Race morning | Message (below); trust the plan. |
| After | Recovery, then debrief within 24 to 48 hours. |
Schedule the wakes: T−10 days check-in, T−3 days logistics, T−1 evening, race morning, next-day debrief.

## Goals
Set an **A goal** (a good day), a **B goal** (a decent day) and a **C goal** (a successful one in difficult conditions: finish healthy, learn). Anchor them to evidence: a recent race or hard time trial, `zones-and-paces` equivalents (`vdot.py`), recent long-run quality, and conditions. Equivalent times are optimistic if the athlete is under-prepared for the distance, particularly the marathon. Be honest about heat, hills, and life disruption. First marathon: finishing comfortably is a legitimate A goal. Record in `races` (`goal` JSON with times) and the profile; remind them that goals can change on race morning.

## Pacing
- **Even or slightly negative** effort is generally best for performance over distances from 5K to marathon (Abbiss and Laursen, 2008). Start at or a touch slower than goal pace; the first 10% should feel too easy.
- **The marathon:** many recreational runners slow markedly after ~30 km; large-scale data suggest those who started more conservatively slowed less (Smyth, 2021). "The race starts at 30 km" is a good mantra.
- **Terrain:** pace by effort on hills (steady effort up, relax down); don't "bank time".
- **Heat and wind:** accept slower paces from the start; see `environment`. Set a heat-adjusted goal in advance.
- **A written race plan** (short): target splits or effort bands per section, when to fuel, a mantra, and **if-then rules** ("if the first 5K is >10 s/km too fast, ease back now"; "if my stomach is off, switch to water for 10 minutes").
- Pace bands help some, distract others; ask.

## Fueling and hydration
General guidance is in `fueling-basics`, which also holds the cautions about restriction and energy availability. For races:
- **Practice everything in training.** Nothing new on race day (expert consensus).
- **Before:** for events ≳ 90 minutes, eat a bit more carbohydrate than usual in the final 1 to 2 days (familiar foods, no restricting, no weighing), and a familiar breakfast 2 to 3 hours before. For shorter races, normal eating is fine.
- **During:** for >1 hour, ~30 to 60 g carbohydrate per hour, starting in the first 30 to 45 minutes; up to ~90 g/h in very long events *if* the gut is trained and mixed sugars are used (Jeukendrup, 2014). Start earlier than feels necessary. Sip fluids to thirst at aid stations; **don't overdrink** (exercise-associated hyponatremia is a real, preventable risk; Hew-Butler et al., 2015).
- **Caffeine:** some athletes benefit; only if they already tolerate it. Not for those with anxiety, arrhythmia or sleep issues, and never first time on race day.

## Logistics checklist
Bib and chip, start time and corral, transport and parking, bag drop, toilets (queue length!), weather-appropriate kit with a throwaway layer, shoes broken in, socks that don't blister, anti-chafe, sunscreen, watch charged and course loaded, gels/chews and where to carry them, cash/phone, meeting point after, what to eat and wear afterwards, hotel check-out time, how to get home. For a destination race: arrive early enough to rest; consider time zone and altitude (`environment`).
Warm-up: 5K/10K, 10 to 15 minutes easy jog, drills, 3 to 4 strides; half and marathon, 5 to 10 minutes easy and strides, then stay warm.

## Race-morning message (short, calm, one or two lines)
Sent by a scheduled wake; if a send is held by policy, it's fine to skip.
> "Good morning. The work is done, now just run your plan: easy first 5K, settle in, and enjoy the day. I'm proud of the training you've put in. Message me when you're done."
Don't coach anxiously; no last-minute tactics.

## After the race
- **First hour:** keep moving gently, warm clothes, fluids, food (carbs and some protein). **Red flags afterwards:** chest pain, fainting, confusion, very dark urine, severe calf swelling, severe pain on a bone: §11.
- **Recovery:** (expert opinion) 5K/10K: 2 to 3 easy or rest days; half: 3 to 7 days easy; marathon: a week or two of easy running and cross-training, then rebuild. Soreness and low energy are normal; persistent pain isn't. Don't plan another hard race too quickly.
- **Debrief** within 24 to 48 hours, in a conversation, not a questionnaire: how did it feel at 5K, halfway, the last quarter? Pacing vs plan; fueling and stomach; weather; what went well; what they'd change; what surprised them. Ask what they're proud of before what went wrong.
- **Data:** record the result in `races.result` (`{"time_s":..,"place":..}`), the activity (screenshot or file), splits; compare to the goal and the plan; update VDOT/paces cautiously (a hot or hilly race understates fitness).
- **Emotional care:** a disappointing or DNF race hurts; acknowledge it before analysing. Post-race lows are common after big goals; if it persists or sounds like more than low mood, follow §11.
- **Next:** a recovery block, then the next goal (or an open break). Ask what they want.

## Worked example (10 days before a half marathon, goal 1:55 / B 1:58)
- Last quality: 6 × 1 km at ~threshold nine days out. Long run 14 km a week out at easy-to-steady effort with 3 km at goal pace; then volume down 40%.
- Week of: Mon easy 8 km + strides, Tue 6 km with 3 × 2 min at goal pace, Thu 5 km easy + strides, Fri rest, Sat 15-min jog + 3 strides, Sun race.
- Plan: 5:30 first 3 km (goal pace 5:27), settle, gels at 40 and 75 minutes, water at every second station, check at 15 km: if feeling good, pick up; if not, hold.
- Messages: T−3 logistics message with a checklist; T−1 evening: "lay out your kit; early night if you can, but don't worry if you can't sleep"; race morning as above; next afternoon: "How are the legs? Tell me the story."

## Pitfalls
New things on race day. Over-tapering into restlessness, or not tapering. Starting too fast. Last-minute training. Carb "loading" turned into eating until sick or, conversely, restriction. Overdrinking. Treating one race as a verdict on the athlete. Forgetting the debrief or recording the result.

## Evidence notes (citations from memory; verify before quoting)
- Taper: *moderate to strong* (Bosquet et al. 2007; Mujika and Padilla 2003).
- Even pacing: *moderate* (Abbiss and Laursen, Sports Med 2008); marathon pacing data: *moderate, observational* (Smyth, PLoS ONE 2021).
- In-race carbohydrate: *strong* for 30 to 60 g/h over 1 to 2.5 h, *moderate* for higher rates with trained gut and mixed sugars (Jeukendrup, Sports Med 2014; Burke et al., J Sports Sci 2011).
- Hyponatremia consensus: *moderate/consensus* (Hew-Butler et al., Clin J Sport Med 2015).
- Caffeine: *strong* for performance, with individual tolerance caveats (Guest et al., J Int Soc Sports Nutr 2021).
- "Nothing new on race day", warm-up routines, recovery durations: *expert opinion*.
