import { useId, useMemo, useState } from 'react';
import type { FormField, MicroForm, MicroUI } from '@opencoach/protocol';
import {
  assembleValues,
  clampScale,
  fieldError,
  initialFormState,
  isFormSubmittable,
  summarizeSubmission,
  type BodyMapEntry,
  type FieldState,
  type FormState,
} from '../lib/microui';
import type { AnswerView } from '../lib/chatModel';
import { answerQuickReply, submitForm } from '../lib/controller';
import { BodyMap } from './BodyMap';
import { useExpired } from './Atoms';
import { Icon } from './Icon';

/** Micro-UI under a coach message (SPEC §9.3): quick-reply chips and an inline form. */
export function MicroUiBlock({ messageId, ui, answer }: { messageId: string; ui: MicroUI; answer?: AnswerView }) {
  const expired = useExpired(ui.expires_at);
  return (
    <div className="microui">
      {ui.quick_replies && ui.quick_replies.length > 0 && <QuickReplies messageId={messageId} replies={ui.quick_replies} answer={answer} expired={expired} />}
      {ui.form && <FormCard messageId={messageId} form={ui.form} answer={answer} expired={expired} />}
      {ui.expires_at && expired && !answer && <p className="microui-note">This question has expired.</p>}
    </div>
  );
}

function QuickReplies({
  messageId,
  replies,
  answer,
  expired,
}: {
  messageId: string;
  replies: NonNullable<MicroUI['quick_replies']>;
  answer?: AnswerView;
  expired: boolean;
}) {
  const answered = answer && answer.action !== 'form_submit';
  const disabled = !!answer || expired;
  return (
    <div className="chips" role="group" aria-label="Quick replies">
      {replies.map((r) => {
        const chosen = answered && (answer.value === r.value || (answer.value === undefined && answer.label === r.label));
        return (
          <button
            key={r.value}
            type="button"
            className={`chip${chosen ? ' chosen' : ''}`}
            disabled={disabled}
            aria-pressed={chosen ? true : undefined}
            onClick={() => void answerQuickReply(messageId, r)}
          >
            {chosen && <Icon name="check" size={14} />}
            {r.label}
          </button>
        );
      })}
      {answered && answer.local && <span className="chip-status">{answer.local === 'queued' ? 'Will send when you are back online' : 'Sending…'}</span>}
    </div>
  );
}

function FormCard({ messageId, form, answer, expired }: { messageId: string; form: MicroForm; answer?: AnswerView; expired: boolean }) {
  const [state, setState] = useState<FormState>(() => initialFormState(form));
  const [touched, setTouched] = useState(false);
  const submitted = answer?.action === 'form_submit';
  const disabled = !!answer || expired;
  const submittable = isFormSubmittable(form, state);
  const summary = useMemo(() => (submitted ? summarizeSubmission(form, answer?.values) : []), [submitted, form, answer?.values]);

  if (submitted) {
    return (
      <div className="form-card done">
        <p className="form-title">
          <Icon name="check" size={16} /> {form.title ?? 'Submitted'}
          {answer?.local && <span className="chip-status">{answer.local === 'queued' ? 'Will send when back online' : 'Sending…'}</span>}
        </p>
        <dl className="form-summary">
          {summary.map((l) => (
            <div key={l.label}>
              <dt>{l.label}</dt>
              <dd>{l.text}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }

  return (
    <form
      className="form-card"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!submittable || disabled) return;
        void submitForm(messageId, form.id, assembleValues(form, state));
      }}
    >
      {form.title && <p className="form-title">{form.title}</p>}
      {form.fields.map((f) => (
        <FieldInput
          key={f.id}
          field={f}
          value={state[f.id]}
          disabled={disabled}
          showError={touched}
          onChange={(v) => setState((s) => ({ ...s, [f.id]: v }))}
        />
      ))}
      <button className="btn primary" type="submit" disabled={disabled || !submittable}>
        {form.submit_label ?? 'Send'}
      </button>
      {expired && <p className="microui-note">This form has expired.</p>}
    </form>
  );
}

function FieldInput({
  field,
  value,
  disabled,
  showError,
  onChange,
}: {
  field: FormField;
  value: FieldState;
  disabled: boolean;
  showError: boolean;
  onChange: (v: FieldState) => void;
}) {
  const id = useId();
  const error = fieldError(field, value);
  const labelId = `${id}-l`;
  let control;
  switch (field.type) {
    case 'scale':
      control = <ScaleInput id={id} field={field} value={value as number | undefined} disabled={disabled} onChange={onChange} />;
      break;
    case 'choice':
      control = (
        <div className="chips" role="radiogroup" aria-labelledby={labelId}>
          {field.options.map((o) => (
            <label key={o.value} className={`chip radio${value === o.value ? ' chosen' : ''}`}>
              <input type="radio" name={id} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} />
              {o.label}
            </label>
          ))}
        </div>
      );
      break;
    case 'multi_choice': {
      const picked = (value as string[] | undefined) ?? [];
      control = (
        <div className="chips" role="group" aria-labelledby={labelId}>
          {field.options.map((o) => {
            const on = picked.includes(o.value);
            return (
              <label key={o.value} className={`chip radio${on ? ' chosen' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  disabled={disabled}
                  onChange={() => onChange(on ? picked.filter((x) => x !== o.value) : [...picked, o.value])}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      );
      break;
    }
    case 'number':
      control = (
        <div className="input-unit">
          <input
            id={id}
            type="text"
            inputMode="decimal"
            value={(value as string | undefined) ?? ''}
            disabled={disabled}
            aria-invalid={!!error}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.unit && <span className="unit">{field.unit}</span>}
        </div>
      );
      break;
    case 'text':
      control = field.multiline ? (
        <textarea id={id} rows={3} maxLength={field.max_len} value={(value as string | undefined) ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input id={id} type="text" maxLength={field.max_len} value={(value as string | undefined) ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      );
      break;
    case 'date':
      control = <input id={id} type="date" value={(value as string | undefined) ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'time':
      control = <input id={id} type="time" value={(value as string | undefined) ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'body_map':
      control = <BodyMap label={field.label} multi={field.multi ?? false} disabled={disabled} value={(value as BodyMapEntry[] | undefined) ?? []} onChange={onChange} />;
      break;
  }
  const useLabelFor = field.type === 'number' || field.type === 'text' || field.type === 'date' || field.type === 'time';
  return (
    <div className="form-field">
      {useLabelFor ? (
        <label htmlFor={id} id={labelId} className="form-label">
          {field.label}
        </label>
      ) : (
        <span id={labelId} className="form-label">
          {field.label}
        </span>
      )}
      {control}
      {showError && error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Slider with anchor labels. Unset until the athlete interacts (so an untouched slider sends nothing). */
function ScaleInput({
  id,
  field,
  value,
  disabled,
  onChange,
}: {
  id: string;
  field: Extract<FormField, { type: 'scale' }>;
  value: number | undefined;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  const mid = clampScale(field, (field.min + field.max) / 2);
  const span = field.max - field.min || 1;
  const anchors = Object.entries(field.anchors ?? {})
    .map(([k, label]) => ({ at: Number(k), label }))
    .filter((a) => Number.isFinite(a.at) && a.at >= field.min && a.at <= field.max);
  const commit = (raw: string) => onChange(clampScale(field, Number(raw)));
  return (
    <div className={`scale${value === undefined ? ' unset' : ''}`}>
      <output htmlFor={id} className="scale-value" aria-live="polite">
        {value === undefined ? 'Drag to choose' : value}
      </output>
      <input
        id={id}
        type="range"
        min={field.min}
        max={field.max}
        step={field.step ?? 1}
        value={value ?? mid}
        disabled={disabled}
        aria-valuetext={value === undefined ? 'not set' : String(value)}
        onChange={(e) => commit(e.target.value)}
        onPointerUp={(e) => commit(e.currentTarget.value)}
        onKeyUp={(e) => {
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') commit(e.currentTarget.value);
        }}
      />
      <div className="scale-ends" aria-hidden="true">
        <span>{field.min}</span>
        <span>{field.max}</span>
      </div>
      {anchors.length > 0 && (
        <div className="scale-anchors">
          {anchors.map((a) => (
            <span key={a.at} style={{ left: `${((a.at - field.min) / span) * 100}%` }}>
              {a.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
