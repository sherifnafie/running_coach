import { useI18n } from '../../lib/i18n';
import { useEffect, useState } from 'react';
import type { AiAccessSummary } from '@opencoach/protocol';
import { Section, Spinner } from '../../components/Atoms';
import { describeError } from '../../lib/api';
import { admin, type AdminAthlete } from '../../lib/endpoints';
import { AiAccessPanel, KeyInput } from './AiSection';
import { Row } from './Controls';

/**
 * Admin (self-host owner / hosted operator; only shown when `me.athlete.isAdmin`).
 * The admin response shapes are not fixed by the contract, so lists are rendered generically.
 */
function asRows(data: unknown, keys: string[] = []): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null);
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>;
    for (const k of [...keys, 'items', 'rows', 'data']) if (Array.isArray(o[k])) return asRows(o[k]);
  }
  return [];
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function GenericTable({ rows, max = 12 }: { rows: Array<Record<string, unknown>>; max?: number }) {
  const t = useI18n();
  if (rows.length === 0) return <p className="hint">{t("Nothing to show.")}</p>;
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 6);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} scope="col">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, max).map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{cell(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useLoad<T>(fn: () => Promise<T>, enabled: boolean) {
  const [state, setState] = useState<{ loading: boolean; data?: T; error?: string }>({ loading: false });
  useEffect(() => {
    if (!enabled || state.data !== undefined) return;
    setState({ loading: true });
    fn()
      .then((data) => setState({ loading: false, data }))
      .catch((e) => setState({ loading: false, error: describeError(e) }));
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

function Block({ title, children }: { title: string; children: (open: boolean) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="admin-block">
      <button type="button" className="list-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="list-title">{title}</span>
      </button>
      {open && <div className="admin-body">{children(open)}</div>}
    </div>
  );
}

function Costs({ open }: { open: boolean }) {
  const t = useI18n();
  const s = useLoad(admin.costs, open);
  if (s.loading) return <Spinner />;
  if (s.error) return <p className="form-error">{s.error}</p>;
  const rows = asRows(s.data, ['byDay', 'days', 'costs']);
  const valueKey = ['usd', 'costUsd', 'cost', 'total', 'amount'].find((k) => rows.some((r) => typeof r[k] === 'number'));
  const dayKey = ['date', 'day'].find((k) => rows.some((r) => typeof r[k] === 'string'));
  const max = valueKey ? Math.max(...rows.map((r) => Number(r[valueKey] ?? 0)), 0.0001) : 0;
  return (
    <>
      {valueKey && dayKey && (
        <ul className="bars" aria-label={t("Cost per day")}>
          {rows.slice(-14).map((r) => (
            <li key={String(r[dayKey])}>
              <span className="bar-label">{String(r[dayKey]).slice(5)}</span>
              <span className="bar" style={{ width: `${Math.max(2, (Number(r[valueKey]) / max) * 100)}%` }} />
              <span className="bar-value">${Number(r[valueKey]).toFixed(2)}</span>
            </li>
          ))}
        </ul>
      )}
      <GenericTable rows={rows} />
    </>
  );
}

function Turns({ open }: { open: boolean }) {
  const t = useI18n();
  const s = useLoad(admin.turns, open);
  const [detail, setDetail] = useState<{ id: string; body?: unknown; error?: string } | null>(null);
  if (s.loading) return <Spinner />;
  if (s.error) return <p className="form-error">{s.error}</p>;
  const rows = asRows(s.data, ['turns']);
  const idOf = (r: Record<string, unknown>) => String(r.id ?? r.turnId ?? '');
  return (
    <>
      <GenericTable rows={rows} />
      {rows.length > 0 && (
        <ul className="list">
          {rows.slice(0, 12).map((r) => (
            <li key={idOf(r)}>
              <button
                type="button"
                className="btn link small"
                onClick={() => {
                  const id = idOf(r);
                  setDetail({ id });
                  admin
                    .turn(id)
                    .then((body) => setDetail({ id, body }))
                    .catch((e) => setDetail({ id, error: describeError(e) }));
                }}
              >
                {t("Trace")} {idOf(r).slice(-8)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {detail && (
        <div className="trace">
          <p className="list-title">{t("Turn")} {detail.id}</p>
          {detail.error ? <p className="form-error">{detail.error}</p> : <pre>{detail.body === undefined ? 'Loading…' : JSON.stringify(detail.body, null, 2)}</pre>}
          <button type="button" className="btn link small" onClick={() => setDetail(null)}>
            {t("Close")}</button>
        </div>
      )}
    </>
  );
}

/** One person: allowance, model, managed key and account recovery [COST-1] [SEC-1]. */
function Person({ athlete }: { athlete: AdminAthlete }) {
  const t = useI18n();
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState<AiAccessSummary | undefined>();
  const [recovery, setRecovery] = useState<{ code: string; expiresAt: string } | undefined>();
  const [error, setError] = useState<string | undefined>();
  const run = async (fn: () => Promise<AiAccessSummary>) => {
    setError(undefined);
    try { setSummary(await fn()); } catch (e) { setError(describeError(e)); }
  };
  useEffect(() => { if (open && !summary) void run(() => admin.ai(athlete.id)); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="admin-block">
      <button type="button" className="list-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="list-title">{athlete.displayName}{athlete.isAdmin ? ` · ${t('admin')}` : ''}</span>
      </button>
      {open && (
        <div className="admin-body">
          {!summary ? (error ? <p className="form-error">{error}</p> : <Spinner />) : (
            <AiAccessPanel summary={summary} canEdit onBudgets={(b) => void run(() => admin.setBudgets(athlete.id, b))} onModel={(m) => void run(() => admin.setModel(athlete.id, m))}>
              {summary.billing === 'managed' && (
                summary.openrouterKey?.owner === 'admin' ? (
                  <Row label={t('Separate OpenRouter key')} hint={t('Calls for this person use this key, so its OpenRouter credit limit applies too.')}>
                    <button type="button" className="btn small" onClick={() => void run(() => admin.removeKey(athlete.id))}>{t('Remove')}</button>
                  </Row>
                ) : (
                  <KeyInput label={t('Separate OpenRouter key (optional)')} hint={t('Create a key with a credit limit at openrouter.ai for this person. Without one, the server key is used.')} onSave={(key) => run(() => admin.setKey(athlete.id, key))} />
                )
              )}
              <Row label={t('Lost access?')} hint={t('A one-time code that signs this person in on a new device. Valid for 30 minutes.')}>
                <button type="button" className="btn small" onClick={async () => {
                  setError(undefined);
                  try { setRecovery(await admin.recoveryCode(athlete.id)); } catch (e) { setError(describeError(e)); }
                }}>{t('Create recovery code')}</button>
              </Row>
              {recovery && <p role="status" className="code-box"><code>{recovery.code}</code></p>}
            </AiAccessPanel>
          )}
          {summary && error && <p className="form-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

function People() {
  const t = useI18n();
  const s = useLoad(admin.athleteList, true);
  if (s.loading) return <Spinner />;
  if (s.error) return <p className="form-error">{s.error}</p>;
  const people = (s.data ?? []).filter((a) => a.status === 'active');
  if (people.length === 0) return <p className="hint">{t('Nothing to show.')}</p>;
  return <>{people.map((a) => <Person key={a.id} athlete={a} />)}</>;
}

const inviteLink = (code: string) => `${location.origin}/?invite=${encodeURIComponent(code)}`;

function Invite() {
  const t = useI18n();
  const [code, setCode] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="admin-body">
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(undefined);
          try {
            setCode((await admin.invite()).code);
          } catch (e) {
            setError(describeError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {t("Create invite code")}</button>
      {code && (
        <>
          <p role="status" className="code-box">
            <code>{code}</code>{' '}
            <button type="button" className="btn link small" onClick={() => void navigator.clipboard?.writeText(code)}>
              {t("Copy")}</button>
          </p>
          <p className="hint">{t("Send them this link. It opens the sign-up form with the code filled in, works once, and expires in 24 hours.")}</p>
          <p className="code-box">
            <code>{inviteLink(code)}</code>{' '}
            <button type="button" className="btn link small" onClick={() => void navigator.clipboard?.writeText(inviteLink(code))}>
              {t("Copy link")}</button>
          </p>
        </>
      )}
      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

export function AdminSection() {
  const t = useI18n();
  return (
    <Section title={t("Admin")}>
      <div className="admin-block">
        <p className="list-title pad">{t("People")}</p>
        <People />
      </div>
      <div className="admin-block">
        <p className="list-title pad">{t("Invite someone")}</p>
        <Invite />
      </div>
      <Block title={t("Costs by day")}>{(open) => <Costs open={open} />}</Block>
      <Block title={t("Recent turns")}>{(open) => <Turns open={open} />}</Block>
    </Section>
  );
}
