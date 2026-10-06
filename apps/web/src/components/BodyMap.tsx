import { useId } from 'react';
import { BODY_REGIONS, type BodyRegion } from '@opencoach/protocol';
import { regionLabel, setSeverity, toggleRegion, type BodyMapEntry } from '../lib/microui';

/**
 * Body map for pain location + 0–10 severity (SPEC §10.3). Front and back figures; every region from the
 * protocol's BODY_REGIONS is reachable by tapping, by keyboard, or through the "Add an area" select.
 * "left"/"right" are the athlete's own sides (so on the front view left is on the viewer's right).
 */
type Shape = { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number } | { kind: 'rect'; x: number; y: number; w: number; h: number; r?: number };

const FRONT: Partial<Record<BodyRegion, Shape>> = {
  head: { kind: 'ellipse', cx: 50, cy: 14, rx: 9, ry: 11 },
  neck: { kind: 'rect', x: 45, y: 25, w: 10, h: 8, r: 3 },
  left_shoulder: { kind: 'ellipse', cx: 69, cy: 40, rx: 8, ry: 6 },
  right_shoulder: { kind: 'ellipse', cx: 31, cy: 40, rx: 8, ry: 6 },
  chest: { kind: 'rect', x: 39, y: 34, w: 22, h: 20, r: 4 },
  abdomen: { kind: 'rect', x: 40, y: 56, w: 20, h: 18, r: 4 },
  left_hip: { kind: 'ellipse', cx: 62, cy: 82, rx: 7, ry: 6 },
  right_hip: { kind: 'ellipse', cx: 38, cy: 82, rx: 7, ry: 6 },
  groin: { kind: 'ellipse', cx: 50, cy: 88, rx: 4, ry: 5 },
  left_quad: { kind: 'rect', x: 53, y: 92, w: 13, h: 34, r: 6 },
  right_quad: { kind: 'rect', x: 34, y: 92, w: 13, h: 34, r: 6 },
  left_itb: { kind: 'rect', x: 67, y: 94, w: 4, h: 30, r: 2 },
  right_itb: { kind: 'rect', x: 29, y: 94, w: 4, h: 30, r: 2 },
  left_knee: { kind: 'ellipse', cx: 59.5, cy: 132, rx: 7, ry: 6 },
  right_knee: { kind: 'ellipse', cx: 40.5, cy: 132, rx: 7, ry: 6 },
  left_shin: { kind: 'rect', x: 54, y: 140, w: 11, h: 34, r: 5 },
  right_shin: { kind: 'rect', x: 35, y: 140, w: 11, h: 34, r: 5 },
  left_ankle: { kind: 'ellipse', cx: 59.5, cy: 181, rx: 5.5, ry: 4 },
  right_ankle: { kind: 'ellipse', cx: 40.5, cy: 181, rx: 5.5, ry: 4 },
  left_arch: { kind: 'ellipse', cx: 56, cy: 191, rx: 3, ry: 4 },
  right_arch: { kind: 'ellipse', cx: 44, cy: 191, rx: 3, ry: 4 },
  left_forefoot: { kind: 'ellipse', cx: 61, cy: 198, rx: 5.5, ry: 4 },
  right_forefoot: { kind: 'ellipse', cx: 39, cy: 198, rx: 5.5, ry: 4 },
  left_toes: { kind: 'ellipse', cx: 61, cy: 205, rx: 5, ry: 2.6 },
  right_toes: { kind: 'ellipse', cx: 39, cy: 205, rx: 5, ry: 2.6 },
};

const BACK: Partial<Record<BodyRegion, Shape>> = {
  neck: { kind: 'rect', x: 45, y: 25, w: 10, h: 8, r: 3 },
  upper_back: { kind: 'rect', x: 36, y: 34, w: 28, h: 22, r: 4 },
  lower_back: { kind: 'rect', x: 40, y: 57, w: 20, h: 17, r: 4 },
  left_glute: { kind: 'ellipse', cx: 42, cy: 85, rx: 8, ry: 8 },
  right_glute: { kind: 'ellipse', cx: 58, cy: 85, rx: 8, ry: 8 },
  left_hamstring: { kind: 'rect', x: 34, y: 97, w: 14, h: 33, r: 6 },
  right_hamstring: { kind: 'rect', x: 52, y: 97, w: 14, h: 33, r: 6 },
  left_calf: { kind: 'rect', x: 35, y: 138, w: 12, h: 32, r: 6 },
  right_calf: { kind: 'rect', x: 53, y: 138, w: 12, h: 32, r: 6 },
  left_achilles: { kind: 'rect', x: 39, y: 172, w: 5, h: 13, r: 2 },
  right_achilles: { kind: 'rect', x: 56, y: 172, w: 5, h: 13, r: 2 },
  left_heel: { kind: 'ellipse', cx: 41, cy: 192, rx: 5, ry: 4 },
  right_heel: { kind: 'ellipse', cx: 59, cy: 192, rx: 5, ry: 4 },
};

/** Silhouette context (not interactive). */
function Silhouette() {
  return (
    <g className="bm-body" aria-hidden="true">
      <ellipse cx="50" cy="14" rx="10" ry="12" />
      <rect x="36" y="28" width="28" height="48" rx="9" />
      <rect x="24" y="32" width="9" height="46" rx="4.500" />
      <rect x="67" y="32" width="9" height="46" rx="4.500" />
      <rect x="35" y="74" width="30" height="20" rx="9" />
      <rect x="33" y="90" width="15" height="92" rx="7" />
      <rect x="52" y="90" width="15" height="92" rx="7" />
      <ellipse cx="40" cy="198" rx="8" ry="9" />
      <ellipse cx="60" cy="198" rx="8" ry="9" />
    </g>
  );
}

function ShapeEl({ s }: { s: Shape }) {
  return s.kind === 'ellipse' ? <ellipse cx={s.cx} cy={s.cy} rx={s.rx} ry={s.ry} /> : <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={s.r ?? 0} />;
}

function Figure({
  title,
  shapes,
  value,
  disabled,
  onToggle,
}: {
  title: string;
  shapes: Partial<Record<BodyRegion, Shape>>;
  value: BodyMapEntry[];
  disabled: boolean;
  onToggle: (r: BodyRegion) => void;
}) {
  return (
    <figure className="bm-figure">
      <svg viewBox="0 0 100 214" role="group" aria-label={`${title} body view`}>
        <Silhouette />
        {(Object.entries(shapes) as Array<[BodyRegion, Shape]>).map(([region, shape]) => {
          const entry = value.find((e) => e.region === region);
          const label = regionLabel(region);
          return (
            <g
              key={region}
              className={`bm-region${entry ? ' on' : ''}`}
              style={entry ? { ['--sev' as string]: String(0.25 + (entry.severity / 10) * 0.6) } : undefined}
              role="button"
              tabIndex={disabled ? -1 : 0}
              aria-label={label}
              aria-pressed={!!entry}
              aria-disabled={disabled}
              onClick={() => !disabled && onToggle(region)}
              onKeyDown={(e) => {
                if (disabled) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle(region);
                }
              }}
            >
              <title>{label}</title>
              <ShapeEl s={shape} />
            </g>
          );
        })}
      </svg>
      <figcaption>{title}</figcaption>
    </figure>
  );
}

export function BodyMap({
  value,
  multi,
  disabled,
  onChange,
  label,
}: {
  value: BodyMapEntry[];
  multi: boolean;
  disabled: boolean;
  onChange: (next: BodyMapEntry[]) => void;
  label: string;
}) {
  const selectId = useId();
  const toggle = (r: BodyRegion) => onChange(toggleRegion(value, r, multi));
  const available = BODY_REGIONS.filter((r) => !value.some((e) => e.region === r));
  return (
    <div className="body-map" role="group" aria-label={label}>
      <div className="bm-figures">
        <Figure title="Front" shapes={FRONT} value={value} disabled={disabled} onToggle={toggle} />
        <Figure title="Back" shapes={BACK} value={value} disabled={disabled} onToggle={toggle} />
      </div>
      <div className="bm-add">
        <label htmlFor={selectId} className="sr-only">
          Add a body area
        </label>
        <select
          id={selectId}
          value=""
          disabled={disabled || (!multi && value.length > 0)}
          onChange={(e) => {
            if (e.target.value) toggle(e.target.value as BodyRegion);
          }}
        >
          <option value="">{value.length === 0 ? 'Or choose an area…' : multi ? 'Add another area…' : 'Tap the area again to change it'}</option>
          {available.map((r) => (
            <option key={r} value={r}>
              {regionLabel(r)}
            </option>
          ))}
        </select>
      </div>
      {value.length > 0 && (
        <ul className="bm-list">
          {value.map((e) => (
            <li key={e.region}>
              <span className="bm-name">{regionLabel(e.region)}</span>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={e.severity}
                disabled={disabled}
                aria-label={`${regionLabel(e.region)} severity, 0 to 10`}
                onChange={(ev) => onChange(setSeverity(value, e.region, Number(ev.target.value)))}
              />
              <output className="bm-sev" aria-hidden="true">
                {e.severity}/10
              </output>
              <button type="button" className="icon-btn small" disabled={disabled} aria-label={`Remove ${regionLabel(e.region)}`} onClick={() => toggle(e.region)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
