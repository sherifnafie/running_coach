import type { ConvItem, ModelRequest } from '@opencoach/protocol';
import type { ScriptedStep, ScriptHandler } from './scripted';

/**
 * Deterministic, rule-based "coach" used when no model API key is configured (`demo: true`), so the
 * whole product can be clicked through and e2e-tested. It reads the rendered event headers described
 * in docs/implementation.md ("Context rendering") and the `<situation>` harness item, and answers with
 * the same tools a real coach would use (send_message with quick replies, write, schedule).
 *
 * Not coaching logic: it is a test double. Never throws.
 */

type ToolCall = NonNullable<ScriptedStep['toolCalls']>[number];

const HEADER = /^\[(?<local>[^·\]]+) · (?<type>[a-z_.]+)(?: · (?<id>[A-Za-z0-9_]+))?\]$/;
const ATHLETE_TYPES = new Set(['user.message', 'user.upload', 'user.voice_note', 'user.ui_action']);
const PROACTIVE_TYPES = new Set(['schedule.fired', 'system.heartbeat']);

interface DemoEvent {
  type: string;
  id?: string;
  local: string;
  date?: string;
  time?: string;
  body: string;
}

// ------------------------------------------------------------------ parsing

function itemText(item: ConvItem): string {
  if (item.kind === 'user') return item.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  if (item.kind === 'harness') return item.text;
  return '';
}

function parseEvents(text: string): DemoEvent[] {
  const events: DemoEvent[] = [];
  let cur: DemoEvent | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = HEADER.exec(line.trim());
    if (m?.groups) {
      const local = (m.groups.local ?? '').trim();
      cur = {
        type: m.groups.type ?? 'unknown',
        id: m.groups.id,
        local,
        date: /\d{4}-\d{2}-\d{2}/.exec(local)?.[0],
        time: /\b\d{2}:\d{2}\b/.exec(local)?.[0],
        body: '',
      };
      events.push(cur);
    } else if (cur) {
      cur.body += (cur.body ? '\n' : '') + line;
    }
  }
  if (events.length === 0 && text.trim()) {
    // No header (a bare user item): treat the whole text as an athlete message.
    events.push({ type: 'user.message', local: '', body: text });
  }
  for (const e of events) e.body = e.body.trim();
  return events;
}

/** The athlete's words in an event body: drop "Athlete:" prefixes and "Attachments:" lines. */
function athleteWords(body: string): string {
  return body
    .split('\n')
    .filter((l) => !/^\s*Attachments?:/i.test(l))
    .map((l) => l.replace(/^\s*Athlete(?:\s*\([^)]*\))?\s*:\s*/i, ''))
    .join('\n')
    .trim();
}

function tappedValue(body: string): string {
  const quoted = /tapped quick reply\s+"([^"]*)"/i.exec(body) ?? /"([^"]*)"/.exec(body);
  if (quoted?.[1] !== undefined) return quoted[1];
  return athleteWords(body);
}

function situationOf(items: ConvItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && it.kind === 'harness' && it.text.includes('<situation>')) return it.text;
  }
  return '';
}

/** Index where the trailing run of user items (skipping harness items) begins, and the last non-harness item. */
function trailingUserRun(items: ConvItem[]): { start: number; last?: ConvItem } {
  let start = items.length;
  let last: ConvItem | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'harness') continue;
    if (last === undefined) last = it;
    if (it.kind === 'user') start = i;
    else break;
  }
  return { start, last };
}

function tomorrowOf(date: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
}

function utcOffsetOf(situation: string): string {
  return /\bnow:\s*\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})/.exec(situation)?.[1] ?? 'Z';
}

// ------------------------------------------------------------------ building blocks

function reply(text: string, opts: { replyTo?: string; quick?: Array<[label: string, value: string]> } = {}): ToolCall {
  return {
    name: 'send_message',
    input: {
      text,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      ...(opts.quick?.length ? { ui: { quick_replies: opts.quick.map(([label, value]) => ({ label: label.slice(0, 24), value: value.slice(0, 200) })) } } : {}),
    },
  };
}

const NOTE = (what: string): ScriptedStep => ({ text: `Demo coach: ${what}` });

const PAIN = /\b(pain|painful|hurt|hurts|hurting|injur\w*|ache|aching|sprain\w*|swollen|swelling)\b/i;
const URGENT = /\b(chest|dizzy|dizziness|faint\w*|breath\w*|numb\w*|collapse\w*)\b/i;
const GOAL = /\b(5k|10k|half marathon|half|marathon|get fit|fitness)\b/i;
const PLAN = /\b(plan|schedule|remind\w*|check[- ]?in)\b/i;
const REST = /\b(rest day|resting|rest)\b/i;
const RAN = /\b(run|ran|running|done|workout|session|tempo|intervals?|jog\w*)\b/i;
/** Past-tense report of a workout ("I ran 5k"), as opposed to naming a goal ("First 5K"). */
const REPORT = /\b(ran|done|finished|completed|did)\b/i;
const NUMERIC = /^\s*(10|[1-9])(?:\s*\/\s*10)?\s*$/;

const GOAL_QUICK: Array<[string, string]> = [
  ['First 5K', 'First 5K'],
  ['Half marathon', 'Half marathon'],
  ['Marathon', 'Marathon'],
  ['Just get fit', 'Just get fit'],
];
const EFFORT_QUICK: Array<[string, string]> = [
  ['2 · very easy', '2'],
  ['4 · easy', '4'],
  ['6 · moderate', '6'],
  ['7 · hard', '7'],
  ['8 · very hard', '8'],
  ['10 · all-out', '10'],
];
const NEXT_QUICK: Array<[string, string]> = [
  ['I just ran', 'I just ran today'],
  ['Make a plan', 'Make me a plan'],
];

// ------------------------------------------------------------------ decisions

function respondToAthlete(args: {
  events: DemoEvent[];
  items: ConvItem[];
  startOfRun: number;
  situation: string;
  imagesAttached: boolean;
}): ScriptedStep {
  const { events, items, startOfRun, situation, imagesAttached } = args;
  const athlete = events.filter((e) => ATHLETE_TYPES.has(e.type));
  const replyTo = [...athlete].reverse().find((e) => e.id)?.id;
  const date = [...athlete].reverse().find((e) => e.date)?.date ?? events.find((e) => e.date)?.date;
  const time = [...athlete].reverse().find((e) => e.time)?.time;

  const words = athlete
    .map((e) => (e.type === 'user.ui_action' ? tappedValue(e.body) : e.type === 'user.upload' ? '' : athleteWords(e.body)))
    .filter(Boolean)
    .join('\n');
  const uploads = athlete.filter((e) => e.type === 'user.upload');
  const hasImages = imagesAttached || uploads.some((e) => /image\//i.test(e.body));

  // 1. safety first
  if (PAIN.test(words)) {
    if (URGENT.test(words)) {
      return {
        toolCalls: [
          reply(
            "That sounds potentially serious. Please stop what you're doing and get medical help now (call your local emergency number if it's severe or sudden). I'm only a scripted demo coach and can't assess this, so please don't wait on me. Tell me once you've been checked out and we'll plan from there.",
            { replyTo },
          ),
        ],
      };
    }
    return {
      toolCalls: [
        reply(
          "I'm sorry that hurts. When something hurts, the safe move is to stop running until we know more. If it's sharp, getting worse, swollen, or comes with chest pain or dizziness, please see a doctor or physio rather than waiting. (I'm a scripted demo coach and can't assess injuries.) Where is it, and how long has it been going on?",
          { replyTo, quick: [['Mild, a few days', 'It is mild and has lasted a few days'], ['Sharp', 'It is a sharp pain'], ['Getting worse', 'It is getting worse']] },
        ),
      ],
    };
  }

  // 2. uploads
  if (uploads.length > 0 && (hasImages || !words)) {
    return {
      toolCalls: [
        reply(
          hasImages
            ? "Thanks for sending that. In demo mode I can't read images, so could you tell me the distance and time instead (for example \"5 km in 28:30\")?"
            : "Thanks, I received your file, but in demo mode I can't open it. How far and how long was the run?",
          { replyTo },
        ),
      ],
    };
  }

  // 3. first-ever conversation
  const hasPriorAssistant = items.slice(0, startOfRun).some((i) => i.kind === 'assistant');
  if (/athlete:\s*new\b/i.test(situation) || !hasPriorAssistant) {
    return {
      toolCalls: [
        reply(
          "Hi, I'm your running coach, with one honest caveat: I'm a scripted demo coach, because no model API key is configured on this server. I can't think for real yet, but you can click through the whole app. To get started: what are you training for?",
          { replyTo, quick: GOAL_QUICK },
        ),
      ],
    };
  }

  // 4. an effort rating
  const numeric = NUMERIC.exec(words.trim());
  if (numeric?.[1]) {
    const n = Number(numeric[1]);
    const tail = n >= 8 ? 'That was a hard one, so go easy tomorrow.' : n <= 3 ? 'Nice and easy.' : 'A solid effort.';
    const calls: ToolCall[] = [];
    calls.push({
      name: 'write',
      input: {
        path: date ? `journal/${date}.md` : 'journal/demo.md',
        content: `# Journal ${date ?? ''}\n\n- ${time ?? 'today'}: effort ${n}/10 (reported to the demo coach)\n`,
      },
    });
    calls.push(reply(`Got it, ${n}/10. I've noted it in your journal. ${tail}`, { replyTo, quick: NEXT_QUICK }));
    return { toolCalls: calls };
  }

  // 5. goals
  if (GOAL.test(words) && !REPORT.test(words)) {
    const goal = GOAL.exec(words)?.[1] ?? 'that';
    const label = goal.charAt(0).toUpperCase() + goal.slice(1);
    return {
      toolCalls: [
        reply(`${label}, great goal! In this demo I can't build a real plan, but say "plan" and I'll schedule a check-in for tomorrow morning, or tell me about a run you did.`, { replyTo, quick: NEXT_QUICK }),
      ],
    };
  }

  // 6. plan / schedule
  if (PLAN.test(words)) {
    const tomorrow = date ? tomorrowOf(date) : undefined;
    if (!tomorrow) {
      return { toolCalls: [reply("I can't tell today's date from this message, so I can't schedule a check-in in demo mode. Tell me about a run instead?", { replyTo })] };
    }
    return {
      toolCalls: [
        {
          name: 'schedule',
          input: {
            id: `demo-checkin-${tomorrow}`,
            spec: { at: `${tomorrow}T08:00:00${utcOffsetOf(situation)}` },
            purpose: 'Demo check-in: ask how the athlete is feeling and whether they got a run in.',
          },
        },
        reply("Done: I've scheduled a check-in for tomorrow at 08:00. (A real coach would build you a proper plan; this demo only schedules the check-in.)", { replyTo }),
      ],
    };
  }

  // 7. rest
  if (REST.test(words)) {
    return { toolCalls: [reply('Rest is part of training. Enjoy it, and tell me how you feel tomorrow.', { replyTo, quick: NEXT_QUICK })] };
  }

  // 8. a run happened: ask for effort
  if (RAN.test(words)) {
    return {
      toolCalls: [reply('Nice work, thanks for telling me. How hard did it feel, from 1 (very easy) to 10 (all-out)?', { replyTo, quick: EFFORT_QUICK })],
    };
  }

  // 9. anything else (including an unrecognised tapped value)
  const tapped = athlete.some((e) => e.type === 'user.ui_action');
  return {
    toolCalls: [
      reply(
        tapped
          ? `Got it: "${words.slice(0, 80)}". I'm a scripted demo coach, so try telling me about a run, asking for a plan, or mentioning if something hurts.`
          : "Thanks for your message! I'm only a scripted demo coach, so I understand a few things: tell me about a run you did, ask for a plan, or mention if something hurts.",
        { replyTo, quick: NEXT_QUICK },
      ),
    ],
  };
}

/** Has a proactive-trigger turn already produced a send_message on this local date? */
function alreadyProactiveToday(items: ConvItem[], before: number, date: string | undefined): boolean {
  if (!date) return false;
  let lastEvents: DemoEvent[] = [];
  for (let i = 0; i < before; i++) {
    const it = items[i]!;
    if (it.kind === 'user') lastEvents = parseEvents(itemText(it));
    else if (it.kind === 'assistant') {
      const sent = it.parts.some((p) => p.type === 'tool_call' && p.name === 'send_message');
      const proactiveOnly = lastEvents.length > 0 && lastEvents.every((e) => PROACTIVE_TYPES.has(e.type));
      if (sent && proactiveOnly && lastEvents.some((e) => e.date === date)) return true;
    }
  }
  return false;
}

function respondToSystem(events: DemoEvent[], items: ConvItem[], startOfRun: number, situation: string): ScriptedStep {
  const proactive = events.find((e) => PROACTIVE_TYPES.has(e.type));
  if (!proactive) {
    if (/reply required:\s*yes/i.test(situation)) {
      return { toolCalls: [{ name: 'no_reply', input: { reason: 'The demo coach has nothing to add for this event.' } }] };
    }
    return NOTE(`nothing to do for ${events[0]?.type ?? 'this event'}.`);
  }
  if (alreadyProactiveToday(items, startOfRun, proactive.date)) {
    return NOTE('already sent a proactive message today, staying quiet.');
  }
  if (proactive.type === 'schedule.fired') {
    const purpose = /^[^:]*:\s*(.+)$/s.exec(proactive.body)?.[1]?.trim();
    return {
      toolCalls: [
        reply(
          `Check-in time (this is the wake-up I scheduled)${purpose ? `: "${purpose.slice(0, 200)}"` : '.'} How are you feeling, and did you get a run in?`,
          { quick: [['Went for a run', 'I just ran today'], ['Rest day', 'Rest day']] },
        ),
      ],
    };
  }
  return {
    toolCalls: [reply('Good day! The demo coach checking in once for today: did you run, or is it a rest day?', { quick: [['I just ran', 'I just ran today'], ['Rest day', 'Rest day']] })],
  };
}

function decide(req: ModelRequest): ScriptedStep {
  const items = Array.isArray(req.items) ? req.items : [];
  const { start, last } = trailingUserRun(items);
  if (!last) return NOTE('no events to answer.');
  if (last.kind === 'tool_results') return NOTE('handled the event; nothing more to do this turn.');
  if (last.kind !== 'user') return NOTE('nothing new to answer.');

  const run = items.slice(start).filter((i): i is Extract<ConvItem, { kind: 'user' }> => i.kind === 'user');
  const events = run.flatMap((i) => parseEvents(itemText(i)));
  const imagesAttached = run.some((i) => i.parts.some((p) => p.type === 'image'));
  const situation = situationOf(items);

  if (events.some((e) => ATHLETE_TYPES.has(e.type))) return respondToAthlete({ events, items, startOfRun: start, situation, imagesAttached });
  return respondToSystem(events, items, start, situation);
}

/**
 * The built-in demo coach used when no API keys are configured (`demo: true`). Deterministic,
 * rule-based; exercises send_message (with quick replies), schedule and write so the whole app can
 * be clicked through and e2e-tested without a model.
 */
export function demoCoachHandler(): ScriptHandler {
  return (req) => {
    try {
      return decide(req);
    } catch {
      return NOTE('could not read that event, so I did nothing.');
    }
  };
}
