import { t, useI18n } from '../../lib/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Section } from '../../components/Atoms';
import { describeError } from '../../lib/api';
import { defaultHealthConnectRange, getHealthConnectPlugin, isHealthConnectAvailable, syncHealthConnect } from '../../lib/healthConnect';
import { Row } from './Controls';

export function HealthConnectSection() {
  const t = useI18n();
  const [plugin] = useState(getHealthConnectPlugin);
  const [available, setAvailable] = useState(false);
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const inFlight = useRef(false);
  const id = useId();

  useEffect(() => {
    let active = true;
    void isHealthConnectAvailable(plugin)
      .then((value) => { if (active) setAvailable(value); })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; };
  }, [plugin]);

  if (!plugin || !available) return null;

  const sync = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const count = await syncHealthConnect(defaultHealthConnectRange(days), plugin);
      setMessage(`${count} workout${count === 1 ? '' : 's'} sent to your coach.`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Section title={t("Health Connect")} hint="Import workouts from this device. Android will ask for permission, and imported workouts are sent to your coach.">
      <Row label="Import period" htmlFor={id}>
        <select id={id} value={days} disabled={busy} onChange={(e) => {
          setDays(Number(e.target.value));
          setError(undefined);
          setMessage(undefined);
        }}>
          {[7, 14, 30].map((period) => <option key={period} value={period}>{t("Last")}{period} {t("days")}</option>)}
        </select>
      </Row>
      <button type="button" className="btn block" disabled={busy} onClick={() => void sync()}>
        {busy ? t("Importing workouts…") : t("Import workouts")}
      </button>
      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="hint" role="status">{message}</p>}
    </Section>
  );
}
