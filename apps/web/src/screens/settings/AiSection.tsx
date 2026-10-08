import { useEffect, useId, useState } from 'react';
import type { AiAccessSummary } from '@opencoach/protocol';
import { Section, Spinner } from '../../components/Atoms';
import { describeError } from '../../lib/api';
import { appStore } from '../../lib/appState';
import { OPENROUTER_OAUTH_MARKER, refreshMe } from '../../lib/controller';
import { aiApi, settingsApi } from '../../lib/endpoints';
import { useI18n } from '../../lib/i18n';
import { lsSet } from '../../lib/storage';
import { useStore } from '../../lib/store';
import { NumberRow, Row, SelectRow, useCommit } from './Controls';

const usd = (n: number) => `$${n.toFixed(n < 10 ? 2 : 0)}`;

/**
 * Who pays, what it costs and which model coaches (SPEC §5.7, [COST-1]). Shared by the athlete's own settings and the
 * administrator's per-person panel; `canEdit` decides whether budgets and the model are editable.
 */
export function AiAccessPanel({ summary, canEdit, onBudgets, onModel, children }: {
  summary: AiAccessSummary;
  canEdit: boolean;
  onBudgets: (b: { dailyUsd: number; monthlyUsd: number }) => void;
  onModel: (model: string, tier: 'coach' | 'deep') => void;
  children?: React.ReactNode;
}) {
  const t = useI18n();
  const model = summary.catalog.find((m) => m.id === summary.model);
  const deep = summary.catalog.find((m) => m.id === summary.deepModel);
  const options = (fallback: string) => summary.catalog.map((m) => ({ value: m.id, label: m.id === fallback ? `${m.label} (${t('default')})` : m.label }));
  const { budgets, usage } = summary;
  const managed = summary.billing === 'managed';
  return (
    <>
      <Row label={t('Paid by')} hint={managed ? t('Your administrator pays. The monthly limit is a hard allowance: when it is used up, your coach pauses until next month.') : t('Your own OpenRouter key. Your limits below are soft; OpenRouter enforces any limit you set on the key.')}>
        <span>{managed ? (summary.openrouterKey ? `${t('Administrator')} (${summary.openrouterKey.hint})` : t('Administrator')) : `${t('You')} (${summary.openrouterKey?.hint ?? ''})`}</span>
      </Row>
      <Row label={t('Used')}>
        <span>{t('Today')} {usd(usage.todayUsd)} / {usd(budgets.dailyUsd)} · {t('This month')} {usd(usage.monthUsd)} / {usd(budgets.monthlyUsd)}</span>
      </Row>
      {canEdit ? (
        <>
          <SelectRow label={t('Chat model')} help={t('Talks with you: replies, check-ins, quick changes. Speed matters here.')} value={summary.model} options={options(summary.defaultModel)} onChange={(m) => onModel(m, 'coach')} />
          <SelectRow label={t('Deep work model')} help={t('Works in the background on plans, reviews and research, where thinking matters more than speed.')} value={summary.deepModel} options={options(summary.defaultDeepModel)} onChange={(m) => onModel(m, 'deep')} />
        </>
      ) : (
        <>
          <Row label={t('Chat model')} hint={model?.description}><span>{model?.label ?? summary.model}</span></Row>
          <Row label={t('Deep work model')} hint={deep?.description}><span>{deep?.label ?? summary.deepModel}</span></Row>
        </>
      )}
      {canEdit ? (
        <>
          <NumberRow label={t('Daily limit')} unit="USD" value={budgets.dailyUsd} min={0} max={1000} step={0.5} onCommit={(v) => onBudgets({ ...budgets, dailyUsd: v })} />
          <NumberRow label={t('Monthly limit')} unit="USD" value={budgets.monthlyUsd} min={0} max={10000} step={1} onCommit={(v) => onBudgets({ ...budgets, monthlyUsd: v })} />
        </>
      ) : null}
      {children}
    </>
  );
}

/** Paste-a-key input; the key is sent once and never shown again. */
export function KeyInput({ label, hint, onSave }: { label: string; hint: string; onSave: (key: string) => Promise<void> }) {
  const t = useI18n();
  const id = useId();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Row label={label} hint={hint} htmlFor={id}>
      <input id={id} type="password" autoComplete="off" spellCheck={false} placeholder="sk-or-…" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button type="button" className="btn small" disabled={busy || draft.trim().length < 10} onClick={async () => {
        setBusy(true);
        try { await onSave(draft.trim()); setDraft(''); } finally { setBusy(false); }
      }}>{t('Save key')}</button>
    </Row>
  );
}

/** Servers without OpenRouter (demo, other endpoints): plain spending limits, as before. */
function BudgetOnlySection() {
  const t = useI18n();
  const budgets = useStore(appStore, (s) => s.me!.settings.budgets);
  const save = useCommit();
  return (
    <Section title={t("Spending limits")} hint={t("Caps on what your coach may spend on AI each day and month. When a limit is reached your coach pauses.")}>
      <NumberRow label={t("Daily limit")} unit="USD" value={budgets.dailyUsd} min={0} max={1000} step={0.5} onCommit={(v) => save({ budgets: { dailyUsd: v } })} />
      <NumberRow label={t("Monthly limit")} unit="USD" value={budgets.monthlyUsd} min={0} max={10000} step={1} onCommit={(v) => save({ budgets: { monthlyUsd: v } })} />
    </Section>
  );
}

export function AiSection() {
  const hasModels = useStore(appStore, (s) => !!s.me?.features.models);
  return hasModels ? <ModelAccessSection /> : <BudgetOnlySection />;
}

function ModelAccessSection() {
  const t = useI18n();
  const isAdmin = useStore(appStore, (s) => !!s.me?.athlete.isAdmin);
  const [summary, setSummary] = useState<AiAccessSummary | undefined>();
  const [error, setError] = useState<string | undefined>();
  const run = async (fn: () => Promise<AiAccessSummary>) => {
    setError(undefined);
    try {
      setSummary(await fn());
      await refreshMe();
    } catch (e) {
      setError(describeError(e));
    }
  };
  useEffect(() => { aiApi.get().then(setSummary, (e) => setError(describeError(e))); }, []);
  const hint = t('Your coach runs on AI models through OpenRouter. This shows who pays, what has been used and which models coach you.');
  if (!summary) return <Section title={t('AI and costs')} hint={hint}>{error ? <p className="form-error">{error}</p> : <Spinner />}</Section>;
  const byok = summary.billing === 'byok';
  return (
    <Section title={t('AI and costs')} hint={hint}>
      <AiAccessPanel
        summary={summary}
        canEdit={byok || isAdmin}
        onModel={(model, tier) => void run(() => aiApi.setModel(model, tier))}
        onBudgets={(budgets) => void run(async () => { await settingsApi.put({ budgets }); return aiApi.get(); })}
      >
        {byok ? (
          <Row label={t('Your OpenRouter key')} hint={t('Disconnecting returns you to the allowance your administrator sets.')}>
            <button type="button" className="btn small" onClick={() => void run(aiApi.removeKey)}>{t('Disconnect')}</button>
          </Row>
        ) : (
          <>
            <Row label={t('Use your own OpenRouter account')} hint={t('Pay for your coach yourself and choose its model. You sign in at OpenRouter and can set a spending limit there.')}>
              <button type="button" className="btn small" onClick={async () => {
                setError(undefined);
                try {
                  const { url } = await aiApi.oauthStart();
                  lsSet(OPENROUTER_OAUTH_MARKER, '1');
                  location.assign(url);
                } catch (e) { setError(describeError(e)); }
              }}>{t('Connect OpenRouter')}</button>
            </Row>
            <KeyInput label={t('Or paste a key')} hint={t('Stored encrypted on this server and never shown again.')} onSave={(key) => run(() => aiApi.setKey(key))} />
          </>
        )}
      </AiAccessPanel>
      {error && <p className="form-error" role="alert">{error}</p>}
    </Section>
  );
}
