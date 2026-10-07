import { useI18n } from '../../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEntry, UiVersionRecord } from '@opencoach/protocol';
import { Section, Spinner } from '../../components/Atoms';
import { describeError } from '../../lib/api';
import { appStore } from '../../lib/appState';
import { deleteAccount, refreshApp, toast } from '../../lib/controller';
import { account, views } from '../../lib/endpoints';
import { waitForExport } from '../../lib/exportJob';
import { formatDateTime } from '../../lib/format';
import { useStore } from '../../lib/store';
import { ConfirmButton } from './Controls';
import { changePresentation } from './changeHistory';

// ---- the coach's changes feed ---------------------------------------------------------------------------------

export function ChangesSection() {
  const t = useI18n();
  const tz = useStore(appStore, (s) => s.me?.settings.profile.tz);
  const locale = useStore(appStore, (s) => s.me?.settings.profile.locale);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ loading: boolean; error?: string; changes?: ChangeEntry[] }>({ loading: false });

  useEffect(() => {
    if (!open || state.changes) return;
    setState({ loading: true });
    views
      .changes()
      .then((r) => setState({ loading: false, changes: r.changes ?? [] }))
      .catch((e) => setState({ loading: false, error: describeError(e) }));
  }, [open, state.changes]);

  return (
    <Section title={t("What your coach changed")} hint={t("Saved updates to your coach's files and screens, newest first.")}>
      <button type="button" className="btn block" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? t("Hide changes") : t("Show changes")}
      </button>
      {open && (
        <div className="changes" aria-live="polite">
          {state.loading && <Spinner />}
          {state.error && (
            <p className="form-error" role="alert">
              {state.error}
            </p>
          )}
          {state.changes?.length === 0 && <p className="hint">{t("Nothing yet.")}</p>}
          <ul className="list">
            {state.changes?.map((c) => {
              const { title, areas } = changePresentation(c, t);
              return (
                <li key={c.commit}>
                  <p className="list-title" dir="auto">{title}</p>
                  <p className="list-meta">{formatDateTime(c.at, tz, locale)}</p>
                  {areas.length > 0 && <p className="list-meta">{areas.join(' · ')}</p>}
                  <details className="change-details">
                    <summary>{t('Technical details')}</summary>
                    <p dir="auto">{c.summary}</p>
                    <p>{t('Local Git revision')}: <code dir="ltr">{c.commit.slice(0, 12)}</code></p>
                    {c.files.length > 0 && <ul>{c.files.map((file) => <li key={file}><code dir="ltr">{file}</code></li>)}</ul>}
                  </details>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Section>
  );
}

// ---- view history & revert ------------------------------------------------------------------------------------------

export function ViewHistorySection() {
  const t = useI18n();
  const appViews = useStore(appStore, (s) => s.app?.views);
  return (
    <Section title={t("Screen history")} hint={t("Don't like a change to one of your screens? Go back to an earlier version.")}>
      {!appViews || appViews.length === 0 ? (
        <p className="hint">{t("Your coach hasn't published any screens yet.")}</p>
      ) : (
        <ul className="list">
          {appViews.map((v) => (
            <ViewHistory key={v.manifest.id} id={v.manifest.id} title={v.manifest.title} current={v.version} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ViewHistory({ id, title, current }: { id: string; title: string; current: string }) {
  const t = useI18n();
  const tz = useStore(appStore, (s) => s.me?.settings.profile.tz);
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<UiVersionRecord[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const load = () =>
    views
      .versions(id)
      .then((v) => setVersions([...v].sort((a, b) => Number(b.version) - Number(a.version))))
      .catch((e) => setError(describeError(e)));

  useEffect(() => {
    if (open && !versions) void load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const revert = async (toVersion?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await views.revert(id, toVersion);
      toast(`${title} was reverted`, 'success');
      await refreshApp();
      await load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li>
      <button type="button" className="list-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="list-title">{title}</span>
        <span className="list-meta">{t("version")} {current}</span>
      </button>
      {open && (
        <div className="history">
          {!versions && !error && <Spinner />}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {versions && versions.length <= 1 && <p className="hint">{t("No earlier versions.")}</p>}
          {versions && versions.length > 1 && (
            <ul className="list nested">
              {versions.map((v) => {
                const isCurrent = v.version === current;
                return (
                  <li key={v.version}>
                    <p className="list-title">
                      {t("Version")} {v.version}
                      {isCurrent ? ' (current)' : ''}
                    </p>
                    <p className="list-meta">
                      {v.summary || t("No summary")} · {formatDateTime(v.publishedAt, tz)} · {v.publishedBy.replace('_', ' ')}
                    </p>
                    {!isCurrent && (
                      <ConfirmButton className="btn small" label={t("Revert to this")} confirmLabel={`Revert to version ${v.version}`} disabled={busy} onConfirm={() => void revert(v.version)} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

// ---- export & delete -----------------------------------------------------------------------------------------------------

export function DataSection() {
  const t = useI18n();
  const [phase, setPhase] = useState<'idle' | 'working' | 'ready' | 'error'>('idle');
  const [message, setMessage] = useState<string | undefined>();
  const [url, setUrl] = useState<string | undefined>();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const start = async () => {
    setPhase('working');
    setMessage(undefined);
    abort.current = new AbortController();
    try {
      const { jobId } = await account.startExport();
      const res = await waitForExport(jobId, { signal: abort.current.signal });
      setUrl(res.url);
      setPhase('ready');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      setPhase('error');
      setMessage(describeError(e));
    }
  };

  return (
    <Section title={t("Your data")} hint={t("Take your coach with you: your workspace, uploads, message history and settings in one bundle.")}>
      <div className="row stack">
        {phase === 'idle' && (
          <button type="button" className="btn block" onClick={() => void start()}>
            {t("Export everything")}</button>
        )}
        {phase === 'working' && (
          <p role="status">
            <Spinner label={t("Preparing export")} /> {t("Preparing your export. This can take a minute.")}</p>
        )}
        {phase === 'ready' && url && (
          <p role="status">
            {t("Your export is ready.")}{' '}
            <a className="btn primary small" href={url} download>
              {t("Download")}</a>{' '}
            <button type="button" className="btn link small" onClick={() => setPhase('idle')}>
              {t("Done")}</button>
          </p>
        )}
        {phase === 'error' && (
          <p role="alert" className="form-error">
            {message}{' '}
            <button type="button" className="btn link small" onClick={() => setPhase('idle')}>
              {t("Try again")}</button>
          </p>
        )}
      </div>
    </Section>
  );
}

export function DeleteSection() {
  const t = useI18n();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const ok = typed.trim() === 'DELETE';
  return (
    <Section title={t("Delete account")} hint={t("Permanently deletes your coach, workspace, uploads and history. Backups are removed within 30 days. This cannot be undone.")}>
      <div className="row stack">
        <label className="field">
          <span>
            {t("Type")} <strong>DELETE</strong> {t("to confirm")}</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="characters" autoComplete="off" name="confirm-delete" />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="btn danger"
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            setError(undefined);
            try {
              await deleteAccount();
            } catch (e) {
              setError(describeError(e));
              setBusy(false);
            }
          }}
        >
          {busy ? 'Deleting…' : t("Delete my account and data")}
        </button>
      </div>
    </Section>
  );
}
