---
name: competition-prep
description: "Prepare for a dated goal event in any sport (race, powerlifting meet, match, test, trip) from about eight weeks out through the debrief: A/B/C goals, peaking and taper, rehearsal, logistics checklist, the morning-of message, recovery and debrief. Points to discipline files for race pacing (running/races.md) and meet day (strength-training/powerlifting.md). Use when a goal event is on the calendar."
---

# Competition preparation

A goal event is a project with a build-up, a peak, a day and an afterlife. It might be a marathon, a powerlifting meet, a sportive, a tournament, a fitness test or a hiking trip. Your job is to help the athlete arrive healthy, rested, practiced and calm, with a plan they believe in, and then to help them make sense of what happened. Discipline specifics: `running/races.md`, `strength-training/powerlifting.md`, or the workspace skill for the sport.

## Timeline (adapt to the event)
| When | What |
|---|---|
| ~8 to 6 weeks out | Confirm goals (A/B/C); learn the event (course or venue, rules, schedule, weigh-in, equipment requirements) via `researcher` or the athlete; start rehearsing event-day routines (fueling, warm-up, kit) in training. |
| ~6 to 3 weeks | Event-specific sessions (race pace, heavy singles and competition commands, match-intensity work); one dress rehearsal. Book travel; think about weather and time zones. |
| Peak and taper | Cut volume, keep intensity and some frequency; length depends on the event (see the discipline file and `plan-design`). |
| Event week | Light, familiar sessions; sleep; familiar food; logistics; short, calm messages. |
| T−2 to T−1 | Kit and documents check, bag packed, travel and timings confirmed, familiar dinner, early night (expect poor sleep the night before: the night *two* before matters most). |
| Event morning | Message (below); trust the plan. |
| After | Recovery, then debrief within 24 to 48 hours. |
Schedule the wakes: T−10 days check-in, T−3 days logistics, T−1 evening, event morning, next-day debrief. Record the event in `goal_events` (`kind`, `sport`, `priority`, `goal` with an athlete-facing `text`) and mark the key sessions leading into it.

## Goals
Set an **A goal** (a good day), a **B goal** (a decent day) and a **C goal** (a successful day in difficult conditions: finish healthy, go 6 for 9, learn). Anchor them to evidence: recent results, tests and training performances, and conditions. Be honest about under-preparation, heat, travel and life disruption. A first event of any kind can have "finish (or total) comfortably and enjoy it" as a legitimate A goal. Record goals in `goal_events.goal` (`text`, `b_text`, `c_text` and structured values) and the profile; remind them goals can change on the day.

## Weight classes and weigh-ins
For weight-class sports, the athlete competes in the class they naturally sit in. Don't plan cuts, dehydration, sauna or fasting strategies, or a class change (constitution §11). If they ask, explain why you won't, and suggest a sports dietitian if a class change matters to them. Record the class and the weigh-in time (it changes meal timing on the day) as facts.

## Rehearse everything
**Nothing new on event day** (expert consensus): food, drink, caffeine, kit, footwear, warm-up, equipment. Rehearse the morning routine on a key training day, at the event's time of day if possible.

## Logistics checklist (pick what applies)
Entry, bib or card, rules and equipment checks, start or flight times, travel and parking, weigh-in time and documents, kit (with spares and a layer for waiting), food and drink for the day (and for a long meet or tournament, the gaps between efforts), toilets and queues, phone and watch charged, who's coming, meeting point, what to eat and wear afterwards, check-out times, getting home. Destination events: arrive early enough to rest; consider time zone, heat and altitude (`environment`).

## Morning-of message (short, calm, one or two lines)
Sent by a scheduled wake; if a send is held by policy, it's fine to skip.
> "Good morning. The work is done; now just follow your plan and enjoy it. I'm proud of the training you've put in. Message me when you're done."
Don't coach anxiously; no last-minute tactics.

## After the event
- **First hours:** keep moving gently, warm clothes, fluids, food. **Red flags afterwards:** chest pain, fainting, confusion, very dark urine, severe calf swelling, severe pain on a bone, a head injury: constitution §11.
- **Recovery:** depends on the event (see the discipline file). Soreness and low energy are normal; persistent pain isn't. Don't plan another hard event too quickly.
- **Debrief** within 24 to 48 hours, as a conversation, not a questionnaire: how it went at each stage; plan vs reality; fueling and nerves; conditions; what went well; what they'd change; what surprised them. Ask what they're proud of before what went wrong.
- **Data:** record the result in `goal_events.result` (`text` plus structured values), the activity and any sets, splits or attempts; compare to the goal; update training targets cautiously (a hot or hilly race, or a meet with a long wait, understates fitness).
- **Emotional care:** a disappointing result or a DNF hurts; acknowledge it before analysing. Post-event lows are common after big goals; if it persists or sounds like more than low mood, follow §11.
- **Next:** a recovery block, then the next goal (or an open break). Ask what they want, and whether the mix of disciplines should change.

## Pitfalls
New things on the day. Over-tapering into restlessness, or not tapering. Starting too hard (too fast, or too-heavy openers). Last-minute training. Carb loading turned into eating until sick or, conversely, restriction. Weight cutting. Treating one event as a verdict on the athlete. Forgetting the debrief or recording the result.

## Evidence notes (citations from memory; verify before quoting)
- Taper (volume down, intensity kept): *moderate to strong*, mostly endurance and swimming data (Bosquet et al., Med Sci Sports Exerc 2007; Mujika and Padilla, Med Sci Sports Exerc 2003); strength-sport tapers: *weak/moderate* (Pritchard et al., J Strength Cond Res 2015; Travis et al., Sports 2020).
- Rapid weight loss before competition harms health and often performance: *moderate/consensus* (Burke et al., IJSNEM 2021 review on making weight).
- "Nothing new on the day", rehearsal and logistics: *expert opinion*.
