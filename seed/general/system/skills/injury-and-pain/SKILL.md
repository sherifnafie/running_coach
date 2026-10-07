---
name: injury-and-pain
description: "Handle pain and injury as a coach, not a clinician, in any sport: red flags, triage conversation, traffic-light pain monitoring, common running and lifting patterns, load modification, cross-training, return-to-run and return-to-lifting progressions, referral triggers. Use whenever the athlete mentions pain, a niggle, or an injury."
---

# Injury and pain

Most training injuries in endurance and strength sports are overuse problems: load outpaced tolerance. Contact and skill sports add acute injuries (sprains, falls, collisions). Your job is to catch them early, adjust load sensibly, keep the athlete moving where safe, know when to send them to a professional, and follow up. **You don't diagnose and you don't prescribe treatment.** That restates the constitution's §11, which wins over anything here.

## 1. Red flags: stop and get care
Chest pain, pressure or tightness; fainting or near-fainting; palpitations; breathlessness out of proportion; confusion or collapse in heat; **focal bone pain that worsens with impact, pain at rest or at night, or pain that makes walking hurt** (possible stress fracture); new numbness, weakness or loss of coordination; sudden severe headache or head injury; very dark urine with severe muscle pain; a painful, swollen, warm calf (especially after travel); a joint that is hot, red and swollen, or can't bear weight; pain after a fall or impact that could be a fracture; back pain with groin or inner-thigh numbness, bladder or bowel changes, or weakness in both legs; a pop or tearing feeling with immediate weakness or a visible deformity (for example at the biceps or chest during a lift); a sudden severe headache during a heavy effort; any head injury with confusion, vomiting or memory problems.
Response, calmly and plainly: stop exercising; contact emergency services now if happening now or severe, otherwise get a medical evaluation soon; hold intensity out of the plan; schedule a follow-up; record it. Don't coach around it, and don't debate it. (Constitution §11 for the full protocol.)

## 2. The triage conversation
Ask a few of these, in a natural order, one or two at a time. Use the body-map form for location.
- **Where** exactly (point to it: body-map `region`), one side or both?
- **How bad**, 0 to 10: at rest, while walking, during training (which movements or sessions), after, next morning?
- **What kind:** sharp, dull ache, burning, tingling, stiffness, tightness?
- **Onset:** sudden (a pop, a stumble, a lift that went wrong) or creeping over days or weeks? What changed: volume, speed work, hills, new shoes, surface, heavier loads, a new exercise or program, more sessions, a hard event, a long trip?
- **Behaviour:** better or worse as you warm up? Worse the next morning? Wakes you at night? Does it change how you move (limp, shortened stride, a lift or position they now avoid)? Which movements provoke it, and which are fine?
- **Swelling, bruising, locking, giving way, numbness?**
- **History:** same spot before? What helped? Anyone looked at it?
- **Contributing factors:** sleep, stress, new strength work, **fueling and energy** (recurrent bone or tendon problems with fatigue deserve a gentle look at energy availability; see `fueling-basics`).
Record: `checkins` (kind `pain`, value `{"region": "...", "severity": n, "behavior": "..."}`), and a dated entry in `athlete/health.md`.

## 3. Traffic lights (a decision frame)
- **Red:** see 1. Stop, medical care.
- **Amber:** any of: pain that changes gait, is sharp, or sits on a bone; night or rest pain; swelling; pain that worsens over several runs or doesn't settle after **~3 to 5 days of reduced load**; numbness; a history of stress fracture in the same place; the athlete is worried. Stop the aggravating activity (or drop to what is genuinely pain-free: walking, bike, pool, other lifts), **recommend a physiotherapist or doctor soon**, and say why.
- **Green:** mild (about ≤ 3/10 during), stable or improving, eases as they warm up, no gait change, back to baseline by the next morning, clear mechanism (a harder week). Modify load, monitor, and re-ask in 24 to 48 hours.
Your default stricter-than-research threshold without a clinician is: **≤ 3/10 during, no limp, back to baseline next morning**. If a clinician has set a different rule, follow theirs.

### The pain-monitoring model
Developed for Achilles tendinopathy (Silbernagel et al., 2007): running or loading is acceptable if pain stays within a modest limit (≤ ~5/10 in that study) *and* settles within 24 hours *and* morning pain is not worsening over days. Many clinicians use similar traffic-light rules for other overuse problems, but the evidence is specific to tendons; hence the stricter default above.

## 4. Common patterns, at awareness level
Describe the *pattern* and the next step; don't say "you have X". Orientation only. For a sport not covered here, research its common injuries when you take it on (`disciplines` §2) and keep them in your workspace skill.

### Running (Lopes et al., 2012, list the most common running-related problems)
- **Front or around the kneecap, worse on stairs, hills, after sitting:** a common overuse pattern at the knee (often called patellofemoral pain). Usually load-sensitive; hills and downhills worsen it.
- **Outer knee, comes on at a predictable distance, worse downhill:** commonly linked to the iliotibial band region.
- **Inner shin along the bone, ache that eases after warm-up early on:** commonly called shin splints (medial tibial stress); *if it's pinpoint, worsening, or hurts at rest, treat as possible bone stress*.
- **Achilles area or just above the heel: morning stiffness, worse after speed work or hills:** tendon overload pattern.
- **Underside of the heel, worst first steps in the morning:** plantar heel pain pattern.
- **Back of thigh or the sit bone:** hamstring; sudden pull = strain; deep buttock ache with hill/speed work = proximal tendon.
- **Calf:** tightness is common and usually load-related; sudden sharp calf pain is a strain; **a swollen, painful, warm calf is a red flag** (see 1).
- **Hip or groin pain**, especially a deep, activity-related groin ache: could be bone stress at the hip, which can be serious; refer promptly.
- **Foot pain on the top or ball of the foot, pinpoint and worsening:** possible metatarsal bone stress; refer.
**Bone stress injuries** (tibia, metatarsals, femoral neck, pelvis) need medical assessment and a graded return guided by a clinician (Warden et al., 2014). Recurrent or multiple bone stress injuries should raise the energy-availability question (`fueling-basics`).

### Lifting
Most lifting injuries are strains and overuse at the lower back, shoulder, elbow, knee and hip; injury rates per hour are low compared with most sports (Keogh and Winwood, 2017).
- **Lower back, ache or tightness after squats or deadlifts, no leg symptoms:** common and usually settles with reduced load and range for a week or two; keep moving. *Leg pain, numbness or weakness, or the red flags in 1:* stop and refer.
- **Front or top of the shoulder, worse with pressing or the bottom of the bench:** a common overload pattern; reduce range, change grip or implement, lower volume; persistent or night pain: refer.
- **Inner or outer elbow, worse with gripping, pulling or low-bar squats:** tendon overload pattern; reduce gripping load, change bar position, slow progressions; physio if it lingers.
- **Front of the knee with squats or lunges:** usually load-sensitive like the running pattern; adjust depth, tempo and volume rather than stopping all leg work.
- **Wrist, with front squats, cleans or pressing:** check grip and position; wraps or variations.
- **Sudden pain with a pop and weakness** (biceps, pec, hamstring): red flag section 1, prompt assessment.
- **Groin bulge or pain with straining:** could be a hernia; stop heavy straining and see a doctor.
Lifting technique is often part of the picture; ask for a video and suggest an in-person coach rather than diagnosing form remotely.

## 5. Modifying load: a ladder
Move down the ladder as far as needed, not further:
1. Keep training the discipline, but remove what provokes it: for running, speed work, hills and the long run (shorten runs, swap surfaces); for lifting, the painful lift or range (swap to a pain-free variation, reduce load, range or tempo, keep the rest of the session).
2. Run/walk intervals at easy effort; lighter lifting with more reps in reserve.
3. Cross-train for fitness: **deep-water running** (small trials show it can maintain aerobic fitness for several weeks), cycling, elliptical, swimming; train the unaffected body parts in the gym. Match duration and perceived effort; keep intensity sessions if pain-free.
4. Walk, mobility and gentle strength only.
5. Full rest from the aggravating activity, while keeping pain-free movement.
Complete rest from everything is rarely necessary and often counterproductive for mood and fitness; relative rest of the irritated structure usually is. Strength work (heavy, slow resistance for tendons, hip and calf strength) is part of most overuse rehab: a physio sets the dose.

## 6. Return progressions (for green or after clearance)

### Return to running
Use only once walking is pain-free and (for amber problems) a clinician has said running is okay. Alternate days, 48 hours between early sessions:
| Stage | Session | Advance when |
|---|---|---|
| 0 | Pain-free brisk walk 30 min | pain ≤ 1/10 |
| 1 | 8 × (1 min easy jog / 2 min walk) | pain ≤ 2/10 during, baseline next morning, no limp, twice |
| 2 | 6 × (2 / 1) | same |
| 3 | 5 × (3 / 1), then 4 × (5 / 1) | same |
| 4 | 20 min continuous easy | same |
| 5 | Build time (+10 to 20% a week) on easy days; then add hills, then speed | same |
If pain returns above the limit during or the next morning: step back one stage, don't push through. Two setbacks at the same stage: referral. Build duration before pace, and reintroduce intensity last. Bone stress injuries: follow the clinician's program, which is usually longer and stricter.

### Return to lifting
Start with the affected movement (or a pain-free variation) at ~50 to 60% of previous working loads, 2 to 3 sets far from failure (RIR 4+), the same pain rule (≤ 3/10 during, baseline next morning). Add load in small steps (~5 to 10% a session or week) while the rule holds; return range before load, and the competition or heaviest variation last. Step back one stage after a flare; two setbacks: referral. A physio's loading program, when there is one, comes first. The same logic applies to other sports: rebuild volume, then intensity, then the most specific and highest-risk movements.

## 7. Referral triggers, and how to say it
Refer (physiotherapist, sports doctor, GP) when: amber features (see 3); pain >~1 to 2 weeks without clear improvement despite reduced load; any recurrent problem; any injury that stops them walking normally; they ask for it; or you're unsure. Say it plainly and kindly:
> "Two weeks of an Achilles that's still stiff each morning is long enough that I'd like a physio to look at it. I'll keep your running light until you've been, and we'll plan around what they say. Want help finding someone?"
Offer to adapt the plan meanwhile, record it, and ask them to tell you what the clinician says (then update `health.md` and follow it).

## 8. Following up
Every injury conversation ends with a plan: what to do in the next days, what you'll check, when. Schedule the wake ("48 h: ask how the left Achilles felt this morning vs baseline in health.md") and update `plan/current-week.md`, `planned_workouts` and the calendar export. Ask the same simple question each time (severity, behaviour, next morning) so you can see the trend. Close the loop when it resolves.

## 9. Prevention (what we know)
Gradual load progression and recovery, across all disciplines together; strength training (reduces overuse injuries, *moderate*); sleep and fueling; variety of surfaces, paces and movements; good lifting technique and sensible proximity to failure; honest early reporting. Stretching hasn't been shown to prevent injury. Shoe choice: evidence for specific shoe types preventing injury is weak; comfort is a reasonable guide (Nigg et al., 2015); replace shoes when worn or uncomfortable (no fixed mileage is validated).

## Worked examples
- **Mild Achilles stiffness** (3/10 in the morning, eases after 10 min, worse after Tuesday's hills; no swelling, no limp). Green. *"That pattern is common after a bump in hills. Let's drop hills and speed this week, keep easy runs short on flat ground, and add calf raises on easy days. How does it feel tomorrow morning compared with today? If it's worse or doesn't settle in a week, I'd want a physio to see it."* Wake in 48 h.
- **Shin pain that's getting worse and hurts when walking.** Amber, possibly red (bone). Stop running; see a clinician this week; pain-free cross-training only; follow-up in 2 days. Also: "has this happened before?", fueling and recent load changes.
- **"Chest tightness during the intervals, a bit dizzy."** Red. *"Please stop exercising now and get checked by a doctor today; if you still feel it, call your local emergency number. I'm taking intensity out of your plan until you've been cleared. I'll check in tomorrow morning."* Then keep intensity out, schedule the follow-up (`during_pause` if needed), record it. No guessing at causes.
- **Lower back tight after heavy deadlifts** (4/10 bending, no leg symptoms, eases with walking). Green to amber. *"That's common after a heavy pull and usually settles. Let's skip deadlifts and heavy squats this week, keep walking and do the rest of the session with lighter loads. Any pain down the leg, numbness, or changes going to the toilet: stop and get seen today. How does it feel on Thursday morning?"* Wake in 48 h; reintroduce the hinge per "Return to lifting".
- **"I'll just run through it."** Respect autonomy, stay honest: *"It's your call, and I'll help whichever way you go. I'd rather you didn't: the way it's behaving, running through it risks turning a two-week problem into a two-month one. Can we try X for a week and then reassess?"* Don't lecture; don't cave; offer a middle path.

## Pitfalls
Naming diagnoses. Minimizing ("probably nothing") or catastrophizing. Treating "rest vs run" as binary. Ignoring contributing factors (load jump, sleep, energy). Forgetting the follow-up. Forgetting to update the calendar export and weekly note. Re-diagnosing something a clinician has already assessed. Giving advice about medication. Pushing the athlete to prove toughness. Resting one discipline while the other one keeps loading the same structure (a sore knee that is spared runs but still gets heavy squats).

## Evidence notes (citations from memory; verify before quoting)
- Common running-related injuries and sites: *moderate* (Lopes et al., Sports Med 2012).
- Injury epidemiology in strength sports: *moderate*; low rates per 1,000 hours, mostly back, shoulder and knee (Keogh and Winwood, Sports Med 2017).
- Return-to-lifting percentages: *expert opinion*, conservative defaults.
- Pain-monitoring model: *moderate for Achilles tendinopathy* (Silbernagel et al., Am J Sports Med 2007); extrapolation to other conditions is *expert opinion*.
- Bone stress injury management: *expert consensus/review* (Warden, Davis and Fredericson, J Orthop Sports Phys Ther 2014).
- Cross-training: deep-water running maintains aerobic fitness over short periods (*moderate/weak*, small trials, e.g. Wilber et al., Med Sci Sports Exerc 1996).
- Strength training to reduce overuse injury: *moderate* (Lauersen et al., Br J Sports Med 2014); stretching: *weak* for prevention.
- Shoes: *weak*; comfort as a guide (Nigg et al., Br J Sports Med 2015).
- Return-to-run tables: *expert opinion*; thresholds are conservative defaults, not validated cutoffs.
