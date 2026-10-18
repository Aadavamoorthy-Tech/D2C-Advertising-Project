'use client';

import { ReactNode, useEffect, useState } from 'react';
import { Check, Lock } from 'lucide-react';
import { CURRENCIES, DEFAULT_SETTINGS, LANDING_PAGES, METRICS, MetricKey, Objective, PERIODS, Settings, TIMEZONES, sanitizeSettings } from './settings';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div className="st-row"><div><b>{label}</b>{hint && <small>{hint}</small>}</div><div className="st-control">{children}</div></div>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`st-switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}><i /><span>{checked ? 'On' : 'Off'}</span></button>;
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { id: T; label: string }[]; onChange: (value: T) => void }) {
  return <div className="st-segmented" role="radiogroup" aria-label={label}>{options.map((option) => <button key={option.id} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? 'active' : ''} onClick={() => onChange(option.id)}>{option.label}</button>)}</div>;
}

export default function SettingsPage({ saved, channels, onSave }: { saved: Settings; channels: string[]; onSave: (next: Settings) => void }) {
  const [draft, setDraft] = useState<Settings>(saved);
  const [maxText, setMaxText] = useState(String(saved.maxBudgetChange));
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');

  // Business settings are edited as a draft; appearance and Action Center changes apply instantly via `saved`.
  const businessKeys = ['workspaceName', 'currency', 'timezone', 'landing', 'period', 'channel', 'metric', 'alerts', 'confirmApply', 'confirmRollback', 'maxBudgetChange', 'objective'] as const;
  const dirty = businessKeys.some((key) => JSON.stringify(draft[key]) !== JSON.stringify(saved[key])) || maxText !== String(saved.maxBudgetChange);

  useEffect(() => { if (!dirty) { setDraft(saved); setMaxText(String(saved.maxBudgetChange)); } }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const edit = (patch: Partial<Settings>) => { setDraft((current) => ({ ...current, ...patch })); setConfirmation(''); setError(''); };
  const instant = (patch: Partial<Settings>) => onSave({ ...saved, ...patch });
  const channelOptions = Array.from(new Set(['', ...channels, draft.channel]));

  function save() {
    const max = Number(maxText);
    if (!draft.workspaceName.trim()) return setError('Workspace name cannot be empty.');
    if (maxText.trim() === '' || !Number.isFinite(max) || max < 0 || max > 100) return setError('Maximum budget change must be a number from 0 to 100.');
    const next = sanitizeSettings({ ...draft, maxBudgetChange: max, theme: saved.theme, sidebar: saved.sidebar, density: saved.density, show: saved.show });
    onSave(next);
    setDraft(next);
    setMaxText(String(next.maxBudgetChange));
    setError('');
    setConfirmation('Settings saved.');
  }

  function discard() {
    setDraft(saved);
    setMaxText(String(saved.maxBudgetChange));
    setError('');
    setConfirmation('');
  }

  function resetAll() {
    if (!window.confirm('Reset all settings to their defaults?')) return;
    onSave(DEFAULT_SETTINGS);
    setDraft(DEFAULT_SETTINGS);
    setMaxText(String(DEFAULT_SETTINGS.maxBudgetChange));
    setError('');
    setConfirmation('Settings reset to defaults.');
  }

  const show = saved.show;
  const alerts = draft.alerts;

  return <>
    <div className="page-heading"><div><h1>Settings</h1><p>Basic preferences for this workspace. Settings are stored in this browser.</p></div></div>
    <div className="st-note">Appearance and Action Center changes apply immediately. Other sections apply when you choose Save Changes.</div>

    <div className="st-grid">
      <section className="panel st-panel"><div className="panel-head"><div><h2>General</h2></div></div>
        <Row label="Workspace Name" hint="Shown in the sidebar.">
          <input value={draft.workspaceName} maxLength={40} onChange={(event) => edit({ workspaceName: event.target.value })} aria-label="Workspace Name" />
        </Row>
        <Row label="Currency" hint="Display symbol only. Values are not converted.">
          <select value={draft.currency} onChange={(event) => edit({ currency: event.target.value })} aria-label="Currency">{CURRENCIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        </Row>
        <Row label="Timezone" hint="Used for dates and times shown in the app.">
          <select value={draft.timezone} onChange={(event) => edit({ timezone: event.target.value })} aria-label="Timezone">{TIMEZONES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        </Row>
        <Row label="Default Landing Page" hint="Opens when the app loads.">
          <select value={draft.landing} onChange={(event) => edit({ landing: event.target.value })} aria-label="Default Landing Page">{LANDING_PAGES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        </Row>
      </section>

      <section className="panel st-panel"><div className="panel-head"><div><h2>Appearance</h2><p>Applies immediately</p></div></div>
        <Row label="Theme"><Segmented label="Theme" value={saved.theme} options={[{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }, { id: 'system', label: 'System' }]} onChange={(theme) => instant({ theme })} /></Row>
        <Row label="Sidebar" hint="Collapsed shows icons only on larger screens."><Segmented label="Sidebar" value={saved.sidebar} options={[{ id: 'expanded', label: 'Expanded' }, { id: 'collapsed', label: 'Collapsed' }]} onChange={(sidebar) => instant({ sidebar })} /></Row>
        <Row label="Density"><Segmented label="Density" value={saved.density} options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }]} onChange={(density) => instant({ density })} /></Row>
      </section>

      <section className="panel st-panel"><div className="panel-head"><div><h2>Performance Defaults</h2></div></div>
        <Row label="Default Period" hint="Applied when the app loads.">
          <select value={draft.period} onChange={(event) => edit({ period: Number(event.target.value) })} aria-label="Default Period">{PERIODS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select>
        </Row>
        <Row label="Default Channel" hint="Applied when the app loads, if the channel exists in the data.">
          <select value={draft.channel} onChange={(event) => edit({ channel: event.target.value })} aria-label="Default Channel">{channelOptions.map((name) => <option key={name || 'all'} value={name}>{name || 'All channels'}</option>)}</select>
        </Row>
        <Row label="Default Metric" hint="Initial metric in Performance Explorer.">
          <select value={draft.metric} onChange={(event) => edit({ metric: event.target.value as MetricKey })} aria-label="Default Metric">{METRICS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
        </Row>
      </section>

      <section className="panel st-panel"><div className="panel-head"><div><h2>Alerts</h2><p>Controls what appears in Action Center</p></div></div>
        <Row label="Performance Alerts" hint="ROAS and profit warnings."><Toggle label="Performance Alerts" checked={alerts.performance} onChange={(value) => edit({ alerts: { ...alerts, performance: value } })} /></Row>
        <Row label="Anomaly Alerts" hint="Unusual revenue days."><Toggle label="Anomaly Alerts" checked={alerts.anomaly} onChange={(value) => edit({ alerts: { ...alerts, anomaly: value } })} /></Row>
        <Row label="Decision Alerts" hint="Decisions waiting for review."><Toggle label="Decision Alerts" checked={alerts.decision} onChange={(value) => edit({ alerts: { ...alerts, decision: value } })} /></Row>
      </section>

      <section className="panel st-panel"><div className="panel-head"><div><h2>Decision Controls</h2></div></div>
        <Row label="Confirm before applying a decision" hint="Asks before approving or simulating."><Toggle label="Require confirmation before applying decision" checked={draft.confirmApply} onChange={(value) => edit({ confirmApply: value })} /></Row>
        <Row label="Confirm before rollback" hint="When off, rollback runs immediately and is recorded with reason “Other”."><Toggle label="Require confirmation before rollback" checked={draft.confirmRollback} onChange={(value) => edit({ confirmRollback: value })} /></Row>
      </section>

      <section className="panel st-panel"><div className="panel-head"><div><h2>Budget Controls</h2></div></div>
        <Row label="Maximum budget change" hint="Default ± limit per item in Budget Optimizer.">
          <span className="st-suffix"><input type="number" min="0" max="100" step="any" inputMode="decimal" value={maxText} onChange={(event) => { setMaxText(event.target.value); setConfirmation(''); setError(''); }} aria-label="Maximum budget change percentage" /><em>%</em></span>
        </Row>
        <Row label="Default optimization objective">
          <select value={draft.objective} onChange={(event) => edit({ objective: event.target.value as Objective })} aria-label="Default optimization objective"><option value="profit">Maximize Adjusted Profit</option><option value="revenue">Maximize Revenue</option></select>
        </Row>
        <Row label="Decision Center review before applying" hint="Budget Optimizer never applies changes. Scenarios are always sent to Decision Center for review.">
          <span className="st-fixed"><Lock size={13} aria-hidden /> Always required</span>
        </Row>
      </section>

      <section className="panel st-panel"><div className="panel-head"><div><h2>Action Center</h2><p>Show or hide sections. Applies immediately</p></div></div>
        <Row label="Today’s Brief"><Toggle label="Show Today’s Brief" checked={show.brief} onChange={(value) => instant({ show: { ...show, brief: value } })} /></Row>
        <Row label="Needs Attention"><Toggle label="Show Needs Attention" checked={show.attention} onChange={(value) => instant({ show: { ...show, attention: value } })} /></Row>
        <Row label="Pending Decisions"><Toggle label="Show Pending Decisions" checked={show.decisions} onChange={(value) => instant({ show: { ...show, decisions: value } })} /></Row>
        <Row label="Top Opportunities"><Toggle label="Show Top Opportunities" checked={show.opportunities} onChange={(value) => instant({ show: { ...show, opportunities: value } })} /></Row>
        <Row label="Recent Alerts"><Toggle label="Show Recent Alerts" checked={show.alerts} onChange={(value) => instant({ show: { ...show, alerts: value } })} /></Row>
      </section>
    </div>

    <div className="st-actions">
      <span className="st-status" role="status">{error ? <b className="st-error">{error}</b> : confirmation ? <><Check size={14} aria-hidden /> {confirmation}</> : dirty ? 'You have unsaved changes.' : ''}</span>
      <button type="button" className="secondary-button" onClick={resetAll}>Reset to defaults</button>
      <button type="button" className="secondary-button" onClick={discard} disabled={!dirty}>Discard</button>
      <button type="button" className="small-action primary-action st-save" onClick={save} disabled={!dirty}>Save Changes</button>
    </div>
  </>;
}
