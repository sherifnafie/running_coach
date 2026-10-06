---
name: training-load
description: "Quantify and reason about training load: weekly volume and time, session-RPE load, monotony and strain, acute:chronic ratios with their critique, wellness check-ins. Includes load.py. Use when judging ramp rate, fatigue or whether a week was too much."
---

# Training load

"Load" is how much stress training put on the athlete. You track it to answer practical questions: Was that week too much? Are we building sensibly? Is the athlete trending toward fatigue or illness? Keep it simple: a few numbers and the athlete's own report beat an elaborate model fed with sparse data.

## What to track (in order of usefulness)
1. **Weekly volume**: km and time on feet (time is fairer across surfaces, paces and sports), number of runs, **longest run**, number of hard sessions. Cheap and clear. The athlete understands it.
2. **Session RPE load (sRPE):** `RPE (1 to 10) × duration (minutes)`, in arbitrary units (AU) (Foster et al., 2001). Works for any sport, needs no HR, captures how hard it *felt*. Ask about 30 minutes after a session: "How hard was the whole session, 1 to 10?" (one tap). Sum per day and week.
3. **Wellness** (sleep, soreness, mood or energy, 1 to 5 each): a one-minute form, a few times a week or when something seems off. Trends matter, single days don't.
4. Optional extras: TRIMP (needs HR and a model; skip unless data is rich), resting HR or HRV trends (noisy; context only).

## Metrics worth knowing
- **Weekly ramp:** this week's volume ÷ last week's. Better: this week ÷ the **average of the previous 4 weeks**, because one light week makes any normal week look like a jump.
- **Long-run share:** longest run ÷ weekly volume. Typical ~25 to 35% at four or more runs a week; higher at three runs a week, lower at six.
- **Monotony and strain** (Foster, 1998): monotony = mean daily load ÷ SD of daily load across the week; strain = weekly load × monotony. Monotony rises when every day looks the same (no easy/hard contrast). High monotony plus high load went with illness and overreaching in Foster's small samples. Use it as a *prompt*: "this week had no real easy days".
- **Acute:chronic workload ratio (ACWR)** (Gabbett, 2016): 7-day load ÷ 28-day average. The "sweet spot 0.8 to 1.3, danger above 1.5" came from team sports. **Critique matters:** the ratio is mathematically coupled (the acute week is inside the chronic window, which creates spurious correlations; Lolli et al. 2019), thresholds don't transfer reliably between sports and data types, rolling and EWMA versions disagree, and the evidence for it predicting individual injury is weak (Impellizzeri et al. 2020). It requires complete, honest data and at least four weeks of history. **Use it only to start a conversation; never tell an athlete a number is "safe" or "dangerous".**

## Running the script
```bash
python3 /system/skills/training-load/scripts/load.py --as-of 2026-10-07 --weeks 8     # sRPE by default
python3 /system/skills/training-load/scripts/load.py --as-of 2026-10-07 --metric time
python3 /system/skills/training-load/scripts/load.py --as-of 2026-10-07 --metric distance --sports run --json
```
It reads `activities` from `/workspace/data/coach.db` read-only, groups by Monday-to-Sunday local weeks, and prints runs, km, hours, longest run, long-run share, ramp, load, monotony, strain and the number of sessions missing RPE, then three ACWR variants (rolling coupled, rolling uncoupled, EWMA) with caveats. Pass `--as-of` from the situation report. **Sessions without RPE are not invented**; they are listed. Ask the athlete for RPE on the ones that matter, or use `--metric time` for a gap-free view.

## How to use it
**Weekly review (a good fit for a Sunday wake):**
1. Run the script. Check the **data first**: missing RPE? A duplicated activity inflating a week (see `data-hygiene`)? A watch glitch?
2. Look at the ramp against the 4-week average, the long-run share, the number of hard days, and whether any easy days were actually easy.
3. Check the person: a quick wellness check or a direct question ("how are the legs this week?"). Their answer outranks the spreadsheet.
4. Decide: hold, build, or deload next week. Say why in a sentence.

**Heuristics (expert practice; evidence in the notes):**
- A week more than **~20 to 30%** above their recent typical week, or a longest run well above anything in the last month, deserves a pause and a reason (maybe a good one: coming off a down week, a planned peak).
- Don't raise volume *and* intensity in the same week. Don't add a hard session when volume is already spiking.
- Build for 2 to 3 weeks, then a lighter week (see `plan-design`).
- After illness, travel, or a bad sleep or stress stretch, expect lower tolerance; don't judge by the old numbers.
- High monotony with a low-contrast week: change the pattern (one genuinely easy day, one rest day) rather than the total.
- Rising RPE for the same sessions, rising resting HR, poor sleep, heavy legs, loss of motivation: a drift toward fatigue. Reduce load before it becomes an injury or illness.

## Worked example
`load.py` for a recreational half-marathoner shows weekly run km of 30, 31, 32, 33, then **50** (+52%), longest run 16.1 km (previous 15). Before alarm, check the data: two activities on Saturday at 08:00 and 08:02, 16.0 and 16.1 km, one a screenshot with confidence 0.6. It's a **duplicate**: real week is ~34 km (+3%). Fix the data (`data-hygiene`), re-run, then say nothing alarming to the athlete.

If the jump were real: "That was a big week (+50%). How do the legs feel? I'd like to keep this one lighter, around 36 km, then build again." Offer the reasoning ("big jumps are where overuse injuries tend to show up") without implying certainty.

## Talking about load with athletes
Use words, not ratios: "a bit more than your usual week", "you've stacked three hard days". Avoid numbers that sound like a risk score. Don't make an athlete anxious about a single number; don't reward overtraining either. If they chase streaks or mileage, shift attention to consistency over weeks and how they feel.

## Pitfalls
Calling a duplicate a spike. Treating missing RPE as zero. Mixing sports without saying so (the script counts all sports in load unless you pass `--sports run`; distance is runs only). Comparing athletes. Over-precision (AU to the unit). Using ACWR to justify a decision you made for other reasons. Ignoring life stress, which doesn't appear in the numbers.

## Evidence notes (strength in brackets; citations are from memory, verify before quoting)
- sRPE as a valid, practical internal-load measure: *moderate to strong* (Foster et al., J Strength Cond Res 2001).
- Monotony/strain: *weak/moderate*; small, mostly early studies (Foster, Med Sci Sports Exerc 1998).
- ACWR: *weak and contested* (Gabbett, Br J Sports Med 2016, versus Impellizzeri et al., Int J Sports Physiol Perform 2020; Lolli et al., Br J Sports Med 2019). The IOC consensus on load and injury (Soligard et al., Br J Sports Med 2016) supports avoiding rapid increases and building tolerance gradually, not any specific ratio.
- The "10% rule": *weak*. A randomized trial in novices found a graded program no better than a standard one for injuries (Buist et al., Am J Sports Med 2008); an observational study found the highest risk with weekly increases above ~30% (Nielsen et al., J Orthop Sports Phys Ther 2014). Large single-session spikes appear to carry risk in recent observational watch-data studies (*weak/moderate*).
- Subjective wellness measures respond to training load more consistently than most objective markers (*moderate*; Saw, Main and Gastin, Br J Sports Med 2016).
