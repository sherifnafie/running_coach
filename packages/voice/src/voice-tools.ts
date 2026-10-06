import { ToolInputs, VOICE_TOOLS, toToolJsonSchema, type ToolName, type ToolSpec } from '@opencoach/protocol';

/**
 * What the realtime voice model is told about each tool (SPEC §11.2, Appendix C §C.2). These descriptions are
 * part of the voice front-end's prompt; the behavioral guidance (tone, when to use which tool) lives in the
 * voice addendum of the briefing, so they stay purely functional.
 */
const DESCRIPTIONS: Partial<Record<ToolName, string>> = {
  lookup:
    "Look something up in the athlete's coaching workspace (training plan, recent sessions, journal, notes, memory). Read-only and fast. " +
    "Use it for factual questions such as what is planned for Thursday or how the last long run went, instead of guessing.",
  consult_coach:
    "Ask the head coach, the athlete's real coaching brain with full history and authority over the plan, for a decision or judgement: changing the plan, " +
    "load or pain questions, anything beyond reading a fact. It takes several seconds, so tell the athlete you are checking with the coach, keep the conversation going, " +
    "then relay the answer faithfully. Put the relevant details from this conversation in `context`.",
  note:
    "Write a short note for the head coach: facts the athlete just told you (how a session felt, pain, sleep, schedule changes) and anything you promised. " +
    "You cannot change the plan or memory yourself; your notes are handed to the coach after the call.",
  end_call: 'End the call. Use it when the athlete says goodbye or the conversation has reached its natural end. Say a brief goodbye first, then call this.',
};

/** The voice toolset as provider-neutral tool specs (JSON Schema derived from the shared zod inputs). */
export function voiceToolSpecs(): ToolSpec[] {
  return VOICE_TOOLS.map((name) => ({
    name,
    description: DESCRIPTIONS[name] ?? name,
    inputSchema: toToolJsonSchema(ToolInputs[name]),
  }));
}
