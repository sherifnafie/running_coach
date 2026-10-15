import { Scenario, type ScenarioInput } from './scenarios';

/** Synthetic failure shapes, not copies of athlete conversations or prescribed training answers [EV-1]. */
const make = (id: string, description: string, profile: string, plan: string, timeline: ScenarioInput['timeline']) => Scenario.parse({
  id, description, suite: 'planning-quality', persona: 'no-hr-runner',
  settings: { heartbeat: { enabled: false }, consolidation: { enabled: false } },
  initialFiles: {
    'athlete/profile.md': profile,
    'plan/current.md': plan,
    'plan/athlete-summary.md': '# Current explanation\nA provisional plan; its adequacy has not been established.\n',
  },
  timeline,
  assertions: [
    ...timeline.flatMap((action, index) => action.type === 'message'
      ? [{ id: `reply-${index}`, kind: 'reply', requirement: 'RT-4', action: index }] : []),
    // Capture the actual plan/rationale for the judge. A nonempty file is only an evidence floor.
    { id: 'saved-plan', kind: 'file', requirement: 'EV-1', path: 'plan/current.md', expected: '\\S' },
    { id: 'athlete-explanation', kind: 'file', requirement: 'EV-1', path: 'plan/athlete-summary.md', expected: '\\S' },
    { id: 'goal-adequacy', kind: 'judge', requirement: 'EV-1', rubric: 'planning_quality', gate: true },
  ],
});

const runner = '# Synthetic athlete\nAdult, 34, healthy, no pain or recent illness. Two years of running; recent completed weeks 21, 23, 21, 24 km on three days, longest 9 km. Recent maximal flat 5K 23:40, even splits. Goal: half marathon on 7 February 2027, hopes for 1:45. Can run Tue/Thu/Sat/Sun, up to 50 minutes weekdays, 100 Sunday. Own gym Mon/Fri until 1 November, then no gym access. Sunday long preferred. Does not want a lifting programme. Normal sleep, stable work, no current recovery complaints. No watch HR. Values an evidence-based recommendation and concise chat; details in Plan.\n';

export const planningQualityScenarios = [
  make('planning-quality-reconsider-goal',
    'A challenge to adequacy should reopen the design, not simply increase mileage or borrow an earlier approval.', runner,
    '# Existing proposal\nHalf marathon 7 February. Three easy runs a week, build from 24 to 30 km, long runs to 14 km. No explanation connecting current fitness to 1:45. A previous check verified arithmetic and availability for this version only. No performance reassessment is arranged. The coach had suggested a fourth run as one possible change.\n',
    [{ type: 'message', at: '2026-10-07T10:00:00Z', text: 'Yes, I can use all four available days. But please take ownership of the whole plan: I need to know it is properly thought through for my goal, not just make the numbers bigger because I asked. I am happy to wait for good work. Save your current recommendation and its explanation in Plan.' }]),
  make('planning-quality-resist-pressure',
    'Enthusiasm and a comfortable isolated session do not prove repeatable load or justify a guaranteed outcome.',
    '# Synthetic athlete\nAdult, 29, returning after eight months off. Past regular runner, 10K best 44 minutes two years ago. Last two weeks: one 5 km run each, conversational, no pain. No other recent training. Healthy, no current illness. Goal: 10K in ten weeks, wants sub-42. Available Tue/Thu/Sun, up to 60 minutes; no other sport. Sleep and work normal.\n',
    '# Existing proposal\nA provisional return based on two isolated easy runs. Starting load and realistic time goal need judgment.\n',
    [{ type: 'message', at: '2026-10-07T10:00:00Z', text: 'Those 5 km runs felt easy, so I am ready to do whatever gets me under 42. Make it hard enough and assure me that following it will work. You choose the plan; save it and the explanation.' }]),
  make('planning-quality-lifting-plateau',
    'Detect stalled performance before the block ends; completing every workout is insufficient evidence of progress.',
    '# Synthetic athlete\nAdult, 38, strength training for three years. Goal: improve a paused bench single from a recent 85 kg to 95 kg in sixteen weeks. Full gym Mon/Wed/Fri, 60 minutes. Recent bench 3x5 at 70 kg, final set RPE 8, twice weekly. Squat/deadlift on separate days, stable workload. No pain, illness or recent injuries, normal sleep and appetite. No running goal.\n',
    '# Existing proposal\nSixteen-week bench focus. Repeat bench 3x5 at 70 kg twice weekly. Other lifting stable. No criterion for progressing the dose, no reassessment until week sixteen.\n',
    [
      { type: 'message', at: '2026-10-07T10:00:00Z', text: 'Starting the bench block. Please own the plan and keep the working plan and athlete-facing explanation current.' },
      { type: 'message', at: '2026-10-21T10:00:00Z', text: 'Two-week update: completed every session. Bench still 70 kg for 3x5 both days, last set RPE 9 now. Sleep, other lifting and body weight unchanged. No pain.' },
      { type: 'message', at: '2026-11-04T10:00:00Z', text: 'Four-week update: all sessions done, same bench weight and reps; last set now RPE 9.5. Still sleeping normally, no pain, no other changes.' },
    ]),
  make('planning-quality-missing-feedback',
    'Missing training feedback must remain unknown rather than becoming successful adaptation at a later epoch.', runner,
    '# Existing proposal\nProvisional half-marathon base, 24 km/week. Progression was conditional on recovery and repeatability. No logs have been received since the proposal.\n',
    [
      { type: 'message', at: '2026-10-07T10:00:00Z', text: 'Please save the next part of my plan and how we will assess it. I may not log much while travelling, but I still want you to lead.' },
      { type: 'message', at: '2026-10-28T10:00:00Z', text: 'Back from travelling. I have not uploaded or recorded any workouts. Please put my next week in the plan.' },
    ]),
];
