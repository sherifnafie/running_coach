import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../lib/i18n';

/** Save status shared by the settings controls ("Saving…" / "Saved"). */
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';
export const SaveContext = createContext<{ commit: (patch: unknown) => Promise<boolean> }>({ commit: async () => false });
export const useCommit = () => useContext(SaveContext).commit;

/** Labels and hints arrive already translated by the caller. */
export function Row({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="row">
      <div className="row-text">
        <label htmlFor={htmlFor} className="row-label">
          {label}
        </label>
        {hint && <p className="row-hint">{hint}</p>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

export function Toggle({ label, hint, checked, onChange, disabled }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </Row>
  );
}

export function SelectRow<T extends string | number>({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <select id={id} value={String(value)} onChange={(e) => onChange((typeof value === 'number' ? Number(e.target.value) : e.target.value) as T)}>
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

/** Text input that commits on blur / Enter. */
export function TextRow({
  label,
  hint,
  value,
  onCommit,
  maxLength,
  list,
  validate,
  autoComplete,
}: {
  label: string;
  hint?: string;
  value: string;
  onCommit: (v: string) => void;
  maxLength?: number;
  list?: string;
  validate?: (v: string) => string | undefined;
  autoComplete?: string;
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const error = validate?.(draft);
  const commit = () => {
    const v = draft.trim();
    if (!v || v === value || error) {
      if (!v || error) setDraft(value);
      return;
    }
    onCommit(v);
  };
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <input
        id={id}
        value={draft}
        maxLength={maxLength}
        list={list}
        autoComplete={autoComplete}
        aria-invalid={!!error}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      {error && <small className="err">{error}</small>}
    </Row>
  );
}

/** Number input that commits when valid, on blur / Enter. */
export function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  unit,
  integer,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  integer?: boolean;
  onCommit: (v: number) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const n = Number(draft.replace(',', '.'));
  const invalid = draft.trim() === '' || !Number.isFinite(n) || n < min || n > max || (integer === true && !Number.isInteger(n));
  const commit = () => {
    if (invalid) {
      setDraft(String(value));
      return;
    }
    if (n !== value) onCommit(n);
  };
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <div className="input-unit">
        <input
          id={id}
          type="number"
          inputMode={integer ? 'numeric' : 'decimal'}
          min={min}
          max={max}
          step={step ?? (integer ? 1 : 0.5)}
          value={draft}
          aria-invalid={invalid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {unit && <span className="unit">{unit}</span>}
      </div>
      {invalid && (
        <small className="err">
          {min} to {max}
        </small>
      )}
    </Row>
  );
}

export function TimeRow({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id}>
      <input id={id} type="time" value={value} onChange={(e) => e.target.value && onCommit(e.target.value)} />
    </Row>
  );
}

/** Two-step destructive button: first click arms it, second confirms (auto-disarms). */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = 'btn',
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const t = useI18n();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => timer.current && clearTimeout(timer.current), []);
  return armed ? (
    <span className="btn-row">
      <button
        type="button"
        className={`${className} danger`}
        onClick={() => {
          setArmed(false);
          onConfirm();
        }}
      >
        {confirmLabel ?? t('Confirm')}
      </button>
      <button type="button" className="btn" onClick={() => setArmed(false)}>
        {t('Cancel')}
      </button>
    </span>
  ) : (
    <button
      type="button"
      className={className}
      disabled={disabled}
      onClick={() => {
        setArmed(true);
        timer.current = setTimeout(() => setArmed(false), 6000);
      }}
    >
      {label}
    </button>
  );
}
