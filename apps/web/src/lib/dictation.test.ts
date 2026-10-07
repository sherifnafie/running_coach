import { describe, expect, it } from 'vitest';
import { joinDraft, TranscriptAssembler } from './dictation';

const delta = (item_id: string, d: string) => ({ type: 'conversation.item.input_audio_transcription.delta', item_id, delta: d });
const done = (item_id: string, transcript: string) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id, transcript });

describe('[UI-1] live dictation transcript assembly', () => {
  it('streams deltas, then replaces each phrase with its final text', () => {
    const a = new TranscriptAssembler();
    expect(a.apply(delta('i1', 'did my'))).toBe(true);
    a.apply(delta('i1', ' long run'));
    expect(a.text()).toBe('did my long run');
    expect(a.settled()).toBe(false);
    a.apply(done('i1', 'Did my long run.'));
    a.apply(delta('i2', 'legs felt'));
    expect(a.text()).toBe('Did my long run. legs felt');
    a.apply(done('i2', 'Legs felt heavy.'));
    expect([a.text(), a.settled()]).toEqual(['Did my long run. Legs felt heavy.', true]);
    expect(a.apply(delta('i2', ' late delta'))).toBe(false); // finals win
  });

  it('keeps spoken order when completions arrive out of order, using commit order', () => {
    const a = new TranscriptAssembler();
    a.apply({ type: 'input_audio_buffer.committed', item_id: 'i1', previous_item_id: null });
    a.apply({ type: 'input_audio_buffer.committed', item_id: 'i2', previous_item_id: 'i1' });
    a.apply(done('i2', 'second.'));
    a.apply(done('i1', 'First,'));
    expect(a.text()).toBe('First, second.');
    a.apply(done('i3', 'Third.'));
    a.apply({ type: 'input_audio_buffer.committed', item_id: 'i4', previous_item_id: 'i2' });
    a.apply(done('i4', 'Between.'));
    expect(a.text()).toBe('First, second. Between. Third.');
  });

  it('ignores unrelated events and empty phrases', () => {
    const a = new TranscriptAssembler();
    expect(a.apply({ type: 'session.created' })).toBe(false);
    a.apply(done('i1', '   '));
    expect(a.text()).toBe('');
  });

  it('joins dictated text onto an existing draft with one space', () => {
    expect(joinDraft('', 'Hello')).toBe('Hello');
    expect(joinDraft('Squats felt', 'heavy today')).toBe('Squats felt heavy today');
    expect(joinDraft('Line one\n', 'line two')).toBe('Line one\nline two');
    expect(joinDraft('Keep this', '')).toBe('Keep this');
  });
});
