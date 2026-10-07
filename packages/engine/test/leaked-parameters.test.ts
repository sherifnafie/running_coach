import { describe, expect, it } from 'vitest';
import { parseCompatibleStream } from '../src/compatible';
import { repairLeakedParameters } from '../src/util';
import { drain, fromArray } from './helpers';

// The exact send_message input DeepSeek V4.1 Flash produced through OpenRouter on 2026-10-07.
const LEAKED = {
  text:
    "To start, two easy ones: **what brings you here**, and **what are you training for**?</text>\n" +
    '<parameter name="ui">{"quick_replies":[{"label":"Get fitter / healthier","value":"Get fitter / healthier"},{"label":"Not sure yet","value":"Not sure yet"}]}',
};

describe('repairLeakedParameters [MSG-3]', () => {
  it('splits XML-style parameters that leaked into a JSON string argument back into arguments', () => {
    expect(repairLeakedParameters(LEAKED)).toEqual({
      text: 'To start, two easy ones: **what brings you here**, and **what are you training for**?',
      ui: { quick_replies: [{ label: 'Get fitter / healthier', value: 'Get fitter / healthier' }, { label: 'Not sure yet', value: 'Not sure yet' }] },
    });
  });

  it('handles several parameters, closing tags, plain-string values and a missing closing tag for the first argument', () => {
    const input = { text: 'Hi\n<parameter name="reply_to">evt_1</parameter>\n<parameter name="voice_note">true</parameter>\n</invoke>' };
    expect(repairLeakedParameters(input)).toEqual({ text: 'Hi', reply_to: 'evt_1', voice_note: true });
  });

  it('never overwrites an argument the call already set, and leaves clean or unrelated input alone', () => {
    expect(repairLeakedParameters({ text: 'Hi</text><parameter name="reply_to">evt_x', reply_to: 'evt_real' })).toEqual({ text: 'Hi', reply_to: 'evt_real' });
    const clean = { text: 'Use <b>bold</b> or a <param> tag in prose', n: 1 };
    expect(repairLeakedParameters(clean)).toBe(clean);
  });

  it('is applied to tool calls parsed from a stream', async () => {
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] });
    const out = await drain(parseCompatibleStream(fromArray([
      chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'send_message', arguments: JSON.stringify(LEAKED) } }] }),
      chunk({}, 'tool_calls'),
    ] as never), { model: 'm', providerId: 'openrouter' }));
    const end = out.find((e) => e.type === 'tool_call_end') as { input: Record<string, unknown> };
    expect(end.input.ui).toMatchObject({ quick_replies: [{ label: 'Get fitter / healthier' }, { label: 'Not sure yet' }] });
    expect(String(end.input.text)).not.toContain('<parameter');
  });
});
