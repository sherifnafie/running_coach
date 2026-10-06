import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_TOOLS, athletePaths } from '@opencoach/protocol';
import { createOpenAIRealtimeProvider } from '../src';
import { FakeOpenAI } from './fake-openai';
import { ATHLETE, makeHarness, type Harness } from './harness';

/** CallService + the real OpenAI provider against the local fake of the OpenAI realtime endpoints. */
describe('realtime call over the OpenAI provider (fake server)', () => {
  let server: FakeOpenAI;
  let h: Harness;

  beforeEach(async () => {
    server = await new FakeOpenAI().start();
  });
  afterEach(async () => {
    await h?.cleanup();
    await server.stop();
  });

  async function begin() {
    h = await makeHarness({ realtimeProvider: (clock) => createOpenAIRealtimeProvider({ apiKey: 'sk-int', baseUrl: server.baseUrl, clock }) });
    const info = await h.service.start(ATHLETE, { purpose: 'weekly check-in' });
    await h.service.attach(ATHLETE, info.callId, 'rtc_integration');
    const conn = await server.nextConnection();
    return { info, conn };
  }

  it('start → attach → tool calls → transcripts → end_call, with files and events', async () => {
    const { info, conn } = await begin();

    // session creation carried the briefing and the four voice tools
    const create = server.requests.find((r) => r.url === '/v1/realtime/client_secrets')!;
    expect(create.json.session.instructions).toBe('BRIEFING for Alex. Purpose: weekly check-in.');
    expect(create.json.session.tools.map((t: { name: string }) => t.name)).toEqual([...VOICE_TOOLS]);
    expect(create.json.session.audio.output.voice).toBe('marin');
    expect(info.connect).toMatchObject({ type: 'openai-webrtc', ephemeralKey: 'ek_test_123', callsUrl: `${server.baseUrl}/realtime/calls` });
    expect(conn.url).toBe('/v1/realtime?call_id=rtc_integration');
    expect(conn.headers.authorization).toBe('Bearer sk-int');

    // athlete asks something that needs the head coach
    conn.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Should I move Sunday’s long run?' });
    conn.send({
      type: 'response.function_call_arguments.done',
      call_id: 'fc_consult',
      name: 'consult_coach',
      arguments: JSON.stringify({ question: 'Move the long run?', context: 'athlete is travelling Saturday' }),
      response_id: 'resp_1',
    });
    conn.send({ type: 'response.done', response: { id: 'resp_1' } });
    const consultOut = await conn.waitFor((m) => m.type === 'conversation.item.create' && m.item.call_id === 'fc_consult');
    expect(JSON.parse(consultOut.item.output)).toEqual({ answer: 'Coach says: yes, Move the long run?' });
    expect(h.calls.consult).toEqual([{ athleteId: ATHLETE, question: 'Move the long run?', context: 'athlete is travelling Saturday' }]);
    await conn.waitFor((m) => m.type === 'response.create');

    conn.send({ type: 'response.output_audio_transcript.done', transcript: 'Yes, let us move it to Monday.' });
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'fc_note', name: 'note', arguments: '{"text":"Long run moved to Monday."}' });
    await conn.waitFor((m) => m.type === 'conversation.item.create' && m.item.call_id === 'fc_note');

    // the voice model hangs up
    conn.send({ type: 'response.function_call_arguments.done', call_id: 'fc_end', name: 'end_call', arguments: '{"reason":"all done"}' });
    await conn.waitFor((m) => m.type === 'conversation.item.create' && m.item.call_id === 'fc_end');
    await vi.waitFor(() => expect(h.eventsOf('call.ended')).toHaveLength(1));
    await vi.waitFor(() => expect(conn.socket.readyState).toBe(conn.socket.CLOSED)); // we closed the sideband

    const ended = h.eventsOf('call.ended')[0]!.payload as { transcriptPath: string; notesPath: string; endedBy: string; callId: string };
    expect(ended).toMatchObject({ callId: info.callId, endedBy: 'coach' });
    const root = athletePaths(h.dataDir, ATHLETE).history;
    const transcript = await readFile(`${root}${ended.transcriptPath.replace('/history', '')}`, 'utf8');
    expect(transcript).toContain('Should I move Sunday’s long run?');
    expect(transcript).toContain('Yes, let us move it to Monday.');
    const notes = await readFile(`${root}${ended.notesPath.replace('/history', '')}`, 'utf8');
    expect(notes).toContain('Long run moved to Monday.');
    expect(notes).toContain('Answer given to the athlete: Coach says: yes, Move the long run?');
    expect(notes).toContain('all done');
  });

  it('the athlete hanging up (provider closes the sideband) ends the call as "athlete"', async () => {
    const { info, conn } = await begin();
    conn.send({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: 'Bye!' });
    conn.socket.close(1000, 'client hung up');
    await vi.waitFor(() => expect(h.eventsOf('call.ended')).toHaveLength(1));
    expect(h.eventsOf('call.ended')[0]!.payload).toMatchObject({ callId: info.callId, endedBy: 'athlete' });
    const transcriptPath = (h.eventsOf('call.ended')[0]!.payload as { transcriptPath: string }).transcriptPath;
    const transcript = await readFile(`${athletePaths(h.dataDir, ATHLETE).history}${transcriptPath.replace('/history', '')}`, 'utf8');
    expect(transcript).toContain('Bye!');
  });

  it('max duration closes the sideband and ends the call (clock-driven)', async () => {
    const { conn } = await begin();
    await h.clock.advanceBy(600_000);
    await vi.waitFor(() => expect(h.eventsOf('call.ended')).toHaveLength(1));
    expect(h.eventsOf('call.ended')[0]!.payload).toMatchObject({ endedBy: 'coach', durationS: 600 });
    await vi.waitFor(() => expect(conn.socket.readyState).toBe(conn.socket.CLOSED));
  });
});
