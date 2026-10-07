import { Scenario, type ScenarioInput } from './scenarios';
const reply = { id: 'delivered', kind: 'reply', requirement: 'RT-4', action: 0 } as const;
const judge = { id: 'commitment-quality', kind: 'judge', requirement: 'EV-1', rubric: 'planning', gate: false } as const;
const history = 'Age 32. Running regularly for two years. No run on 6 October; normal flat routes. Healthy, no current pain or illness, no injuries in the last year. Four recent completed weeks: 18, 20, 20, 22 km, three easy runs each week; longest 8 km. Available Tuesday and Thursday (50 minutes each) and Sunday (75 minutes). No HR device. Comfortable 10K in eight weeks; no time goal. Stable sleep and work schedule.';
const make = (id: string, description: string, text: string, checks: ScenarioInput['assertions'], initialFiles: Record<string, string> = {}) => Scenario.parse({
  id, description, suite: 'planning', persona: 'no-hr-runner',
  personaOverrides: {
    profile: { age: 32 },
    availability: { days: ['tue', 'thu', 'sun'], constraints: [] },
    history: { yearsRunning: 2, runsPerWeek: 3, weeklyKm: 22, longestRunKm: 8, injuries: [], recentRaces: [] },
    goals: [{ race: 'Comfortable 10K', distanceKm: 10, date: '2026-12-02', priority: 'A' }],
  },
  initialFiles, timeline: [{ type: 'message', at: '2026-10-07T10:00:00Z', text }], assertions: [reply, ...checks, judge],
});
export const planningScenarios = [
  make('planning-thin-intake', 'Sparse intake must not silently become a firm four-week prescription.',
    'I want to get fitter. I have jogged a few times but have not told you how much, my health or which days I can train. Can you make me a four-week plan?', [
      { id: 'health-intake', kind: 'reply', requirement: 'EV-1', action: 1, expected: '(?:pain|injur|illness|health|medical)' },
      { id: 'no-premature-calendar', kind: 'db', requirement: 'EV-1', action: 0, table: 'planned_workouts', column: 'date', rowCount: 0 },
      { id: 'still-intake', kind: 'db', requirement: 'EV-1', action: 1, table: 'planned_workouts', column: 'date', rowCount: 0 },
    ], { 'athlete/profile.md': '# Intake\nAdult athlete. Wants to get fitter. Current running, health and availability have not been provided.\n' }),
  make('planning-requested-week', 'Respect a one-week request instead of inflating it to a block.',
    `${history} Please save a simple plan for just 7–13 October 2026. I do not want a longer block yet.`, [
      { id: 'availability', kind: 'plan', requirement: 'EV-1', action: 0 },
      { id: 'requested-horizon', kind: 'plan_horizon', requirement: 'EV-1', action: 0, horizonDays: 7 },
    ]),
  make('planning-reviewed-block', 'A four-week commitment should have checked evidence, a separate review and adaptation rules.',
    `${history} Please design and save a four-week base block for 7 October–3 November 2026. Do the careful design and an independent review before finalizing it. For this benchmark keep the checked design in plan/drafts/benchmark.md and the review in plan/reviews/benchmark.md. Tell me the assumptions, why it fits my current running, what would make us change it and when we will review.`, [
      { id: 'availability', kind: 'plan', requirement: 'EV-1', action: 0 },
      { id: 'requested-horizon', kind: 'plan_horizon', requirement: 'EV-1', action: 0, horizonDays: 28 },
      { id: 'design-evidence', kind: 'file', requirement: 'EV-1', action: 0, path: 'plan/drafts/benchmark.md', expected: '(?=[\\s\\S]*(?:18|20|22))(?=[\\s\\S]*(?:assum|unknown|uncertain))(?=[\\s\\S]*(?:load|volume|distance|km))' },
      { id: 'review-evidence', kind: 'file', requirement: 'EV-1', action: 0, path: 'plan/reviews/benchmark.md', expected: '(?=[\\s\\S]*(?:constraint|availab|schedule))(?=[\\s\\S]*(?:load|progress|recover))' },
    ]),
];
// Let the first reply establish rapport; check health before turning a stated starting dose into a block.
planningScenarios[0]!.timeline.push({ type: 'message', at: '2026-10-07T10:05:00Z', text: 'Call me Sam. Fitter means jogging half an hour comfortably. I have done a comfortable 20-minute jog twice a week for two weeks. I can train Tuesday, Thursday and Sunday. I have not told you about my health yet.' });
