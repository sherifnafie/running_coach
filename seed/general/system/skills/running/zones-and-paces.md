# Running: zones and paces

Part of the `running` skill. Effort guidance that is not running-specific (RPE anchors, the talk test, heart-rate pitfalls) applies to other endurance sports too: cycling, rowing and swimming have their own pace or power equivalents, which a workspace skill should cover.

Intensity guidance exists to protect two things: easy days that are truly easy, and hard days that are truly hard but not heroic. Pick the simplest measuring stick that works for *this* athlete. Effort-based methods (RPE, talk test) are robust and free; heart rate and pace are useful but each fails in specific situations.

## Three domains are enough
Physiology has two thresholds that split intensity into three domains. Most "zone systems" (3, 5, 7 zones) are different maps of the same territory.
1. **Easy** (below the first threshold): conversational, can speak full sentences, breathing relaxed, feels like you could go on for hours. RPE 2 to 4 of 10.
2. **Moderate / "comfortably hard"** (between thresholds): short sentences, controlled but working: tempo, marathon-pace work. RPE 5 to 7.
3. **Hard** (above the second threshold): a few words at most; intervals, hills, races up to ~1 hour. RPE 7 to 10.
With athletes, speak in these terms and in RPE. Keep zone numbers for the data they use themselves.

## The measuring sticks

**RPE** (Borg-style 1 to 10). Always available, accounts for heat, fatigue and terrain. Teach the anchors: 1 to 2 very easy (walking-plus), 3 to 4 easy (chat comfortably), 5 to 6 steady (short sentences), 7 to 8 hard (a few words), 9 to 10 very hard to maximal. Ask for it after sessions (also feeds `training-load`).

**Talk test.** Full sentences = below the first threshold; only short phrases = between; unable = above the second. Simple, remarkably consistent, and good for "is today's easy run actually easy?"

**Heart rate.**
- *Max HR:* formulas fail individuals: `220 − age` has a spread of roughly ±10 to 12 bpm; Tanaka's `208 − 0.7 × age` is a bit better on average but still ±10. Best estimate is a hard recent effort (the end of a 5K race, or a few hard uphill efforts), taking the highest reliable value; wrist HR spikes are artefacts.
- *Zones:* percentages of max, or heart-rate reserve (Karvonen: rest + p × (max − rest)), or relative to a threshold HR. Common five-zone maps (very approximately: Z1 under ~70% of max, Z2 70 to 80, Z3 80 to 87, Z4 87 to 93, Z5 above) differ between devices and authors; none is "right". Prefer a **range for easy** (e.g. "mostly under 150, and if it drifts above 155 slow down") derived from the athlete's own data and talk test over a table.
- *Threshold HR:* a solo 30-minute all-out effort, average HR of the last 20 minutes, is a common field estimate (expert practice).
- *Pitfalls:* HR is a lagging indicator for short intervals; it **drifts up** over long steady runs (cardiac drift); heat, dehydration, poor sleep, illness, caffeine and altitude push it up; day-to-day variation of 5 to 10 bpm is normal; wrist sensors can be wrong (cadence lock, loose strap, cold). Trust a chest strap over a wrist; trust effort over both when they disagree.

**Pace.** Great for steady efforts on flat, known routes and for races. Poor for hills, wind, heat and trails. Express as **ranges**, not points ("5:35 to 6:00/km, slower is fine"). Use pace for tempo and race-specific sessions; use effort or HR for easy runs.

**Power** (a watch or foot pod): fine if the athlete has it; not needed.

## VDOT-style paces and race equivalents
Daniels' VDOT converts a race result into an "effective VO2max" index, then into training paces and equivalent times at other distances. Use the script, not memory:
```bash
python3 /system/skills/running/scripts/vdot.py --race 5k 20:00          # VDOT ≈ 49.8, paces, equivalents
python3 /system/skills/running/scripts/vdot.py --race half 1:35:10 --units mi
python3 /system/skills/running/scripts/vdot.py --vdot 52 --json
```
It prints easy (59 to 74% of VO2max, a range), marathon (equivalent marathon pace), threshold (~88%), interval (~VO2max pace) and repetition (mile pace), plus equivalent times for 1500 m to the marathon.

**What the paces are for.** *Easy*: most running, recovery, long runs; the slow end is fine. *Marathon*: marathon-specific work. *Threshold*: "comfortably hard", about what you could hold for an hour: steady 20 to 40 minutes, or cruise intervals (e.g. 4 × 8 min with 1-minute jogs). *Interval*: 3 to 5 minute reps at about VO2max with comparable-duration jogs. *Repetition*: short (≤ 2 min) fast reps with full recovery for speed and economy; not an endurance pace.

**Limits, in plain terms.**
- The equations come from a small, fit, mostly male 1960s to 1970s sample and assume equal training for every distance. Equivalents are only valid if the athlete is equally prepared: **marathon predictions from a 5K are usually optimistic for runners with modest weekly volume or long-run experience.** Say "if you were equally trained" and give a range.
- A single race is noisy: heat, hills, a bad day, a pacing error. Prefer a recent (within ~6 to 8 weeks), honest, evenly paced effort, or a 3 to 5 km time trial run for the purpose. A tuneup that was run as a workout understates fitness.
- Watch "VO2max" estimates are not lab values and can be biased (high or low) for individuals; their trend is more informative than the number. Don't set paces from them alone.
- The published tables are rounded and differ by a few seconds from the formulas.
- Paces are a starting hypothesis. If the prescribed easy pace feels hard, or tempo feels too easy, effort wins and the numbers get updated. Re-derive after new races or time trials, a layoff, illness, or a clear change in how sessions feel.

## Heat, terrain and altitude
Adjust effort, not pace. In heat, humidity, wind, hills and at altitude the same effort is slower (see the `environment` skill). On hilly routes prescribe by effort or HR; grade-adjusted pace models help afterwards for comparing runs, but the uphill penalty is larger than the downhill gain, so average pace on hills understates fitness.

## Coaching without HR (or without a watch)
It is real coaching, not a fallback. Prescribe by RPE and talk test and by *time on feet*:
- "Easy 40 min, conversation pace (RPE 3 to 4)."
- "Tempo: 10 min easy, 20 min comfortably hard (RPE 6 to 7, short sentences), 10 min easy."
- "6 × 3 min hard but controlled (RPE 8), 2 min jog between."
Calibrate with the athlete: after a steady session ask "could you chat? how many words?"; use parkrun or a 3 km route as a repeatable test; track "pace at RPE X" over months instead of absolute pace.

## Updating intensity guidance
Review at block boundaries and after races: has easy pace at the same effort or HR improved (a positive sign of fitness), or HR at a fixed pace drifted up (fatigue, heat, illness)? Retest every 6 to 10 weeks with a race or time trial. After 2+ weeks off, drop the paces by one notch and re-earn them.

## Worked examples
- **20:00 5K.** `vdot.py --race 5k 20:00` → VDOT ≈ 49.8: easy roughly 4:54 to 5:53/km (most runs mid-range, ~5:20 to 5:40), marathon ≈ 4:32/km, threshold ≈ 4:16/km, interval ≈ 3:51/km, repetition ≈ 3:38/km. Marathon equivalent ≈ 3:11, *if* they've built the long runs and weekly volume. For a runner on 30 km a week, a wider and later range (something like 3:20 to 3:30, purely illustrative) is more honest.
- **No recent race.** Ask for a hard recent parkrun or run a 3 km time trial after a proper warm-up; use the result as VDOT and say it is provisional.
- **HR 165 on an "easy" 6:00/km run that felt easy.** Think cadence lock, heat, caffeine, poor sleep, cardiac drift, or a max HR higher than assumed. Compare with the athlete's talk test; adjust the HR range to what easy actually looks like on a strap, not what a formula says.

## Pitfalls
One pace for every easy run. Treating zone tables as precise. Prescribing pace on a hilly or hot day. Using a 5K race run in a fade to define everything. Not saying "slower is fine." Quoting HR zones from a formula as if measured. Forgetting that prescribing by pace punishes the athlete who is tired or ill.

## Evidence notes
- Intensity-domain (two-threshold) model: *strong* physiological basis; boundaries vary by individual.
- Talk test tracks the first ventilatory threshold well in several small studies (*moderate*; e.g. Persinger et al., Med Sci Sports Exerc 2004).
- RPE as a valid intensity measure: *strong* (Borg 1982; Foster et al. 2001 for session RPE).
- `220 − age` is statistical folklore with large individual error (*strong* that it is imprecise; Robergs and Landwehr 2002; Tanaka et al., J Am Coll Cardiol 2001).
- VDOT equations: Daniels and Gilbert, *Oxygen Power* (1979); Daniels, *Daniels' Running Formula*. Useful, *moderate* accuracy for well-trained runners, weaker at the extremes of distance and training state.
- 30-minute-test threshold HR: *weak/expert opinion*.
- Citations are given from memory; verify before quoting them to anyone.
