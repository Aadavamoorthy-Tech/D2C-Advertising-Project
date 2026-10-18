'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Info, Lock, Minus, RotateCcw, Save } from 'lucide-react';
import { formatDateTime, withCurrency } from './settings';

const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

type Objective = 'revenue' | 'profit';
type Level = 'channel' | 'campaign';
type CampaignRow = {
  campaign_id?: string;
  sku_id?: string;
  channel?: string;
  spend?: number | null;
  attributed_revenue?: number | null;
  return_adjusted_net_profit?: number | null;
  record_count?: number | null;
};
type Unit = { key: string; label: string; sub?: string; spend: number; revenue: number; profit: number; records: number };
type Constraint = { min: string; max: string; locked: boolean; lockAmt: string; exclude: boolean };
type Level3 = 'Low' | 'Medium' | 'High';
type Row = {
  key: string; label: string; sub?: string; held: 'locked' | 'excluded' | null;
  current: number; recommended: number; change: number; changePct: number; roas: number | null;
  reason: string; confidence: Level3; risk: Level3; riskWhy: string;
};
type Impact = {
  current_budget: number; recommended_budget: number; budget_moved: number;
  current_revenue: number; est_revenue: number; current_profit: number; est_profit: number;
  current_roas: number | null; est_roas: number | null;
};
type Result =
  | { ok: false; error: string; signature: string }
  | { ok: true; rows: Row[]; impact: Impact; signature: string; objective: Objective; level: Level; total: number; maxPct: number };
type SavedScenario = { id: string; name: string; objective: string; total_budget: number; created_at: string; sent: boolean };

const EMPTY: Constraint = { min: '', max: '', locked: false, lockAmt: '', exclude: false };
const PRIOR_RECORDS = 30;
const objectiveLabel: Record<Objective, string> = { revenue: 'Maximize Revenue', profit: 'Maximize Adjusted Profit' };

function amount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—';
  return withCurrency(new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value));
}
function signedAmount(value: number) {
  const text = amount(Math.abs(value));
  return value > 0 ? `+${text}` : value < 0 ? `-${text}` : text;
}
function pct(value: number | null | undefined, digits = 1) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;
}
function roasFmt(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? '—' : `${value.toFixed(2)}x`;
}
function rateFmt(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}
const finite = (value: number | null | undefined): number => (value != null && Number.isFinite(value) ? value : 0);

function buildUnits(rows: CampaignRow[], level: Level): Unit[] {
  const usable = rows.filter((row) => Number(row.spend) > 0);
  if (level === 'campaign') {
    return usable.map((row) => ({
      key: `${row.campaign_id}|${row.sku_id}`,
      label: String(row.campaign_id ?? 'Unnamed campaign'),
      sub: row.channel,
      spend: finite(row.spend),
      revenue: finite(row.attributed_revenue),
      profit: finite(row.return_adjusted_net_profit),
      records: finite(row.record_count),
    }));
  }
  const byChannel = new Map<string, Unit>();
  for (const row of usable) {
    const name = String(row.channel ?? 'Unassigned');
    const unit = byChannel.get(name) ?? { key: name, label: name, spend: 0, revenue: 0, profit: 0, records: 0 };
    unit.spend += finite(row.spend);
    unit.revenue += finite(row.attributed_revenue);
    unit.profit += finite(row.return_adjusted_net_profit);
    unit.records += finite(row.record_count);
    byChannel.set(name, unit);
  }
  return [...byChannel.values()];
}

const parseOptional = (text: string): number | null => (text.trim() === '' ? null : Number(text));
const cents = (value: number) => Math.round(value * 100);
const confidenceOf = (records: number): Level3 => (records >= 100 ? 'High' : records >= PRIOR_RECORDS ? 'Medium' : 'Low');

function optimize(
  units: Unit[],
  setup: { objective: Objective; level: Level; budgetText: string; maxPctText: string; constraints: Record<string, Constraint> },
  signature: string,
): Result {
  const fail = (error: string): Result => ({ ok: false, error, signature });
  if (!units.length) return fail('No campaigns with recorded spend are available to optimize.');
  const maxPct = Number(setup.maxPctText);
  if (setup.maxPctText.trim() === '' || !Number.isFinite(maxPct) || maxPct < 0 || maxPct > 100) {
    return fail('Maximum change per campaign must be a number between 0 and 100.');
  }
  const currentCents = units.map((unit) => cents(unit.spend));
  const currentTotalCents = currentCents.reduce((sum, value) => sum + value, 0);
  const budgetValue = parseOptional(setup.budgetText);
  if (budgetValue !== null && (!Number.isFinite(budgetValue) || budgetValue <= 0)) {
    return fail('Total available budget must be a positive number.');
  }
  const totalCents = budgetValue === null ? currentTotalCents : Math.floor(budgetValue * 100 + 1e-6);

  const totalSpend = units.reduce((sum, unit) => sum + unit.spend, 0);
  const totalRevenue = units.reduce((sum, unit) => sum + unit.revenue, 0);
  const totalProfit = units.reduce((sum, unit) => sum + unit.profit, 0);
  const blendedRevenueRate = totalRevenue / totalSpend;
  const blendedProfitRate = totalProfit / totalSpend;
  const blendedRate = setup.objective === 'revenue' ? blendedRevenueRate : blendedProfitRate;
  const shrink = (value: number, records: number, prior: number) => (records * value + PRIOR_RECORDS * prior) / (records + PRIOR_RECORDS);

  const lows: number[] = [];
  const highs: number[] = [];
  const held: Array<Row['held']> = [];
  const userBound: Array<{ min: boolean; max: boolean }> = [];
  for (let i = 0; i < units.length; i += 1) {
    const unit = units[i];
    const constraint = setup.constraints[unit.key] ?? EMPTY;
    const limited = unit.records < PRIOR_RECORDS;
    const share = (limited ? maxPct * 0.25 : maxPct) / 100;
    userBound.push({ min: false, max: false });
    if (constraint.locked) {
      const lockedValue = parseOptional(constraint.lockAmt);
      if (lockedValue !== null && (!Number.isFinite(lockedValue) || lockedValue < 0)) return fail(`Locked budget for ${unit.label} must be zero or more.`);
      const lockedCents = lockedValue === null ? currentCents[i] : cents(lockedValue);
      lows.push(lockedCents); highs.push(lockedCents); held.push('locked');
    } else if (constraint.exclude) {
      lows.push(currentCents[i]); highs.push(currentCents[i]); held.push('excluded');
    } else {
      const min = parseOptional(constraint.min);
      const max = parseOptional(constraint.max);
      if ((min !== null && (!Number.isFinite(min) || min < 0)) || (max !== null && (!Number.isFinite(max) || max < 0))) {
        return fail(`Minimum and maximum budgets for ${unit.label} must be zero or more.`);
      }
      if (min !== null && max !== null && min > max) return fail(`Minimum budget exceeds maximum budget for ${unit.label}.`);
      let low = min !== null ? cents(min) : Math.ceil(currentCents[i] * (1 - share) - 1e-6);
      let high = max !== null ? cents(max) : Math.floor(currentCents[i] * (1 + share) + 1e-6);
      if (min === null && max !== null && low > high) low = high;
      if (max === null && min !== null && high < low) high = low;
      lows.push(Math.max(0, low)); highs.push(Math.max(Math.max(0, low), high)); held.push(null);
      userBound[i] = { min: min !== null, max: max !== null };
    }
  }

  const lowSum = lows.reduce((sum, value) => sum + value, 0);
  const highSum = highs.reduce((sum, value) => sum + value, 0);
  if (totalCents < lowSum || totalCents > highSum) {
    return fail(`The simulation budget of ${amount(totalCents / 100)} cannot be reached within the current constraints. Reachable range: ${amount(lowSum / 100)} to ${amount(highSum / 100)}. Adjust the budget, the maximum change, or the constraints.`);
  }

  const revenueRates = units.map((unit) => shrink(unit.revenue / unit.spend, unit.records, blendedRevenueRate));
  const profitRates = units.map((unit) => shrink(unit.profit / unit.spend, unit.records, blendedProfitRate));
  const scores = setup.objective === 'revenue' ? revenueRates : profitRates;
  const allocation = [...lows];
  let remaining = totalCents - lowSum;
  const order = units.map((_, index) => index).filter((index) => held[index] === null)
    .sort((a, b) => scores[b] - scores[a] || units[b].spend - units[a].spend);
  for (const index of order) {
    const add = Math.min(highs[index] - lows[index], remaining);
    allocation[index] += add;
    remaining -= add;
  }

  const metricName = setup.objective === 'revenue' ? 'revenue per unit of spend' : 'adjusted profit per unit of spend';
  let estimatedRevenue = totalRevenue;
  let estimatedProfit = totalProfit;
  let moved = 0;
  const rows: Row[] = units.map((unit, i) => {
    const current = currentCents[i] / 100;
    const recommended = allocation[i] / 100;
    const change = recommended - current;
    const delta = change;
    estimatedRevenue += revenueRates[i] * delta;
    estimatedProfit += profitRates[i] * delta;
    if (delta > 0) moved += delta;
    const changePct = current > 0 ? (change / current) * 100 : 0;
    const confidence = confidenceOf(unit.records);
    const changed = allocation[i] !== currentCents[i];
    const rawRate = (setup.objective === 'revenue' ? unit.revenue : unit.profit) / unit.spend;
    let reason: string;
    if (held[i] === 'locked') reason = `Locked by you at ${amount(recommended)}`;
    else if (held[i] === 'excluded') reason = 'Excluded from optimization; held at its current budget';
    else if (allocation[i] > currentCents[i]) {
      reason = `Ranked higher on ${metricName} (${rateFmt(rawRate)}; overall ${rateFmt(blendedRate)}), so it receives budget first`;
      if (allocation[i] === highs[i]) reason += userBound[i].max ? '; stopped at your maximum' : `; stopped at the ±${maxPct}% change limit`;
    } else if (allocation[i] < currentCents[i]) {
      reason = `Ranked lower on ${metricName} (${rateFmt(rawRate)}; overall ${rateFmt(blendedRate)}); budget moved to higher-ranked items`;
      if (allocation[i] === lows[i]) reason += userBound[i].min ? '; stopped at your minimum' : `; stopped at the ±${maxPct}% change limit`;
    } else reason = 'Held at its current budget; remaining budget went to higher-ranked items or limits were reached';
    if (confidence === 'Low' && held[i] === null) reason += '. Limited data: change capped at a quarter of the maximum';
    const factors: string[] = [];
    if (changed && Math.abs(changePct) >= 15) factors.push('large budget shift');
    if (changed && confidence === 'Low') factors.push('limited historical data');
    if (changed && ((userBound[i].max && allocation[i] === highs[i]) || (userBound[i].min && allocation[i] === lows[i]))) factors.push('at your budget limit');
    const risk: Level3 = factors.length >= 2 ? 'High' : factors.length === 1 ? 'Medium' : 'Low';
    return {
      key: unit.key, label: unit.label, sub: unit.sub, held: held[i], current, recommended, change, changePct,
      roas: unit.spend > 0 ? unit.revenue / unit.spend : null, reason, confidence, risk,
      riskWhy: factors.length ? factors.join(', ') : 'No elevated risk factors',
    };
  });

  const recommendedTotal = allocation.reduce((sum, value) => sum + value, 0) / 100;
  const impact: Impact = {
    current_budget: currentTotalCents / 100,
    recommended_budget: recommendedTotal,
    budget_moved: moved,
    current_revenue: totalRevenue,
    est_revenue: Math.max(0, estimatedRevenue),
    current_profit: totalProfit,
    est_profit: estimatedProfit,
    current_roas: totalSpend > 0 ? totalRevenue / totalSpend : null,
    est_roas: recommendedTotal > 0 ? Math.max(0, estimatedRevenue) / recommendedTotal : null,
  };
  return { ok: true, rows, impact, signature, objective: setup.objective, level: setup.level, total: totalCents / 100, maxPct };
}

function Direction({ change }: { change: number }) {
  if (Math.abs(change) < 0.005) return <span className="bo-dir flat"><Minus size={12} aria-hidden />No change</span>;
  return change > 0
    ? <span className="bo-dir up"><ArrowUp size={12} aria-hidden /><span className="sr-only">Increase </span>{signedAmount(change)}</span>
    : <span className="bo-dir down"><ArrowDown size={12} aria-hidden /><span className="sr-only">Decrease </span>{signedAmount(change)}</span>;
}

export default function BudgetOptimizer({ campaigns, onNavigate, defaultObjective = 'profit', defaultMaxChange = 20 }: { campaigns: CampaignRow[] | null; onNavigate: (section: string) => void; defaultObjective?: Objective; defaultMaxChange?: number }) {
  const [level, setLevel] = useState<Level>('channel');
  const [objective, setObjective] = useState<Objective>(defaultObjective);
  const [budgetText, setBudgetText] = useState('');
  const [maxPctText, setMaxPctText] = useState(String(defaultMaxChange));
  const [constraints, setConstraints] = useState<Record<string, Constraint>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<{ id: string; signature: string; sent: boolean } | null>(null);
  const [scenarios, setScenarios] = useState<SavedScenario[]>([]);
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; title: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMethod, setShowMethod] = useState(false);

  const units = useMemo(() => buildUnits(campaigns || [], level), [campaigns, level]);
  const signature = JSON.stringify({ objective, level, budgetText, maxPctText, constraints });
  const stale = Boolean(result) && result?.signature !== signature;
  const currentTotal = units.reduce((sum, unit) => sum + unit.spend, 0);
  const totalRevenue = units.reduce((sum, unit) => sum + unit.revenue, 0);
  const totalProfit = units.reduce((sum, unit) => sum + unit.profit, 0);
  const simulationBudget = budgetText.trim() === '' ? currentTotal : Number(budgetText);
  const lockedCount = units.filter((unit) => constraints[unit.key]?.locked).length;
  const excludedCount = units.filter((unit) => !constraints[unit.key]?.locked && constraints[unit.key]?.exclude).length;
  const customLimits = units.filter((unit) => constraints[unit.key]?.min?.trim() || constraints[unit.key]?.max?.trim()).length;
  const good = result?.ok && !stale ? result : null;

  async function loadScenarios() {
    try {
      const response = await fetch(`${API}/api/budget-scenarios`, { cache: 'no-store' });
      if (response.ok) setScenarios((await response.json()).items || []);
    } catch { /* the saved list is optional */ }
  }
  useEffect(() => { void loadScenarios(); }, []);

  function update(key: string, patch: Partial<Constraint>) {
    setConstraints((current) => ({ ...current, [key]: { ...(current[key] ?? EMPTY), ...patch } }));
  }
  function run() {
    setNote(null);
    setSaved(null);
    setResult(optimize(units, { objective, level, budgetText, maxPctText, constraints }, signature));
  }
  function reset() {
    setLevel('channel'); setObjective(defaultObjective); setBudgetText(''); setMaxPctText(String(defaultMaxChange));
    setConstraints({}); setResult(null); setName(''); setSaved(null); setNote(null);
  }

  async function post(path: string, body?: unknown) {
    const response = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.detail;
      throw new Error(typeof detail === 'string' ? detail : 'The request was not accepted.');
    }
    return data as { id: string; decision_id: string | null };
  }

  async function submit(send: boolean) {
    if (!good || !good.ok) return;
    const scenarioName = name.trim() || `${objectiveLabel[good.objective]} · ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
    setBusy(true);
    setNote(null);
    try {
      if (send && saved && saved.signature === good.signature && !saved.sent) {
        await post(`/api/budget-scenarios/${saved.id}/send`);
        setSaved({ ...saved, sent: true });
      } else {
        const data = await post('/api/budget-scenarios', {
          name: scenarioName, objective: good.objective, level: good.level, total_budget: good.total,
          max_change_pct: good.maxPct, send,
          constraints: units.filter((unit) => constraints[unit.key]).map((unit) => ({ key: unit.key, label: unit.label, ...constraints[unit.key] })),
          allocation: good.rows.map((row) => ({ key: row.key, label: row.label, current: row.current, recommended: row.recommended, change: row.change, reason: row.reason })),
          impact: good.impact,
        });
        setSaved({ id: data.id, signature: good.signature, sent: send });
      }
      setNote(send
        ? { tone: 'ok', title: 'Sent to Decision Center', text: 'The simulation is waiting for review there. No budget was changed.' }
        : { tone: 'ok', title: 'Scenario saved', text: 'Saving does not apply any budget change.' });
      void loadScenarios();
    } catch (err) {
      setNote({ tone: 'error', title: send ? 'Could not send to Decision Center' : 'Could not save scenario', text: err instanceof Error ? err.message : 'Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (!campaigns) return <div className="state-card">Loading campaign data…</div>;

  const impact = good && good.ok ? good.impact : null;
  const revenueChange = impact ? impact.est_revenue - impact.current_revenue : null;
  const profitChange = impact ? impact.est_profit - impact.current_profit : null;
  const changedRows = good && good.ok ? good.rows.filter((row) => Math.abs(row.change) >= 0.005).sort((a, b) => Math.abs(b.change) - Math.abs(a.change)) : [];
  const dash = (value: string | null) => (stale ? <span className="bo-muted">Rerun</span> : value ?? <span className="bo-muted">—</span>);

  return <>
    <div className="page-heading"><div>
      <h1>Budget Optimizer <span className="mini-tag bo-badge">SIMULATION</span></h1>
      <p>Simulate budget reallocations and compare their estimated impact before making a decision.</p>
    </div><div className="explorer-meta"><button type="button" className="bo-link" onClick={() => setShowMethod(true)}>How is this calculated? <Info size={13} aria-hidden /></button></div></div>

    <div className="bo-kpis explorer-kpis">
      <div><span>Current Total Budget</span><strong>{amount(currentTotal)}</strong></div>
      <div><span>Recommended Total Budget</span><strong>{impact ? amount(impact.recommended_budget) : dash(null)}</strong></div>
      <div><span>Budget Reallocated</span><strong>{impact ? amount(impact.budget_moved) : dash(null)}</strong></div>
      <div><span>Estimated Revenue Impact</span><strong>{impact && revenueChange !== null ? `${signedAmount(revenueChange)} (${pct(impact.current_revenue > 0 ? (revenueChange / impact.current_revenue) * 100 : null)})` : dash(null)}</strong></div>
      <div><span>Estimated Profit Impact</span><strong>{impact && profitChange !== null ? signedAmount(profitChange) : dash(null)}</strong></div>
      <div><span>Estimated ROAS</span><strong>{impact ? roasFmt(impact.est_roas) : dash(null)}</strong></div>
    </div>

    <section className="panel"><div className="panel-head"><div><h2>Optimization Setup</h2><p>Nothing is applied to any advertising platform. Results appear only after you run the optimization.</p></div></div>
      <div className="bo-form">
        <label>Optimize by<select value={level} onChange={(event) => setLevel(event.target.value as Level)}><option value="channel">Channel</option><option value="campaign">Campaign</option></select></label>
        <label>Objective<select value={objective} onChange={(event) => setObjective(event.target.value as Objective)}><option value="profit">Maximize Adjusted Profit</option><option value="revenue">Maximize Revenue</option></select></label>
        <label>Total Available Budget<input type="number" min="0" step="any" inputMode="decimal" value={budgetText} placeholder={`Current: ${amount(currentTotal)}`} onChange={(event) => setBudgetText(event.target.value)} /></label>
        <label>Maximum change per item (±%)<input type="number" min="0" max="100" step="any" inputMode="decimal" value={maxPctText} onChange={(event) => setMaxPctText(event.target.value)} /></label>
      </div>
      <p className="bo-hint">Current total budget: <b>{amount(currentTotal)}</b> · Simulation budget: <b>{Number.isFinite(simulationBudget) ? amount(simulationBudget) : '—'}</b>{budgetText.trim() === '' && ' (same as current; type a value to change it)'}</p>
    </section>

    <section className="panel"><div className="panel-head"><div><h2>Current Allocation</h2><p>Observed figures for the filtered data. The data has no separate budget field, so recorded spend is used as the current budget.</p></div></div>
      {units.length ? <div className="table-scroll bo-scroll"><table className="explorer-table"><thead><tr><th>{level === 'channel' ? 'Channel' : 'Campaign'}</th><th className="num">Spend (Current Budget)</th><th className="num">Revenue</th><th className="num">Adjusted Profit</th><th className="num">ROAS</th><th className="num">Budget Share</th></tr></thead>
        <tbody>{units.map((unit) => <tr key={unit.key}><td>{unit.label}{unit.sub && <small>{unit.sub}</small>}</td><td className="num">{amount(unit.spend)}</td><td className="num">{amount(unit.revenue)}</td><td className="num">{amount(unit.profit)}</td><td className="num">{roasFmt(unit.revenue / unit.spend)}</td><td className="num">{currentTotal > 0 ? `${((unit.spend / currentTotal) * 100).toFixed(1)}%` : '—'}</td></tr>)}</tbody>
        <tfoot><tr><td><b>Total</b></td><td className="num">{amount(currentTotal)}</td><td className="num">{amount(totalRevenue)}</td><td className="num">{amount(totalProfit)}</td><td className="num">{roasFmt(currentTotal > 0 ? totalRevenue / currentTotal : null)}</td><td className="num">100%</td></tr></tfoot></table></div>
        : <p className="bo-hint">No campaigns with recorded spend are available for the current filters.</p>}
    </section>

    <section className="panel"><div className="panel-head"><div><h2>Constraints</h2><p>Locked items keep the amount you set. Excluded items are ignored during reallocation and keep their current budget.</p></div></div>
      {units.length > 0 && <div className="table-scroll bo-scroll"><table className="explorer-table"><thead><tr><th>{level === 'channel' ? 'Channel' : 'Campaign'}</th><th>Minimum Budget</th><th>Maximum Budget</th><th>Lock Budget</th><th>Exclude from Optimization</th><th>Data</th></tr></thead>
        <tbody>{units.map((unit) => {
          const c = constraints[unit.key] ?? EMPTY;
          const frozen = c.locked || c.exclude;
          return <tr key={unit.key} className={c.locked ? 'bo-locked' : undefined}><td>{c.locked && <Lock size={12} aria-label="Locked" />} {unit.label}{unit.sub && <small>{unit.sub}</small>}</td>
            <td><input aria-label={`Minimum budget for ${unit.label}`} type="number" min="0" step="any" disabled={frozen} value={c.min} placeholder="Auto" onChange={(event) => update(unit.key, { min: event.target.value })} /></td>
            <td><input aria-label={`Maximum budget for ${unit.label}`} type="number" min="0" step="any" disabled={frozen} value={c.max} placeholder="Auto" onChange={(event) => update(unit.key, { max: event.target.value })} /></td>
            <td><label className="bo-check"><input type="checkbox" checked={c.locked} onChange={(event) => update(unit.key, { locked: event.target.checked, exclude: event.target.checked ? false : c.exclude })} />Lock</label>{c.locked && <input aria-label={`Locked amount for ${unit.label}`} type="number" min="0" step="any" value={c.lockAmt} placeholder={amount(unit.spend)} onChange={(event) => update(unit.key, { lockAmt: event.target.value })} />}</td>
            <td><label className="bo-check"><input type="checkbox" checked={c.exclude && !c.locked} disabled={c.locked} onChange={(event) => update(unit.key, { exclude: event.target.checked })} />Exclude</label></td>
            <td>{unit.records < PRIOR_RECORDS ? <span className="bo-tag warn">Limited data</span> : <span className="bo-muted">{confidenceOf(unit.records)} confidence</span>}</td></tr>;
        })}</tbody></table></div>}
      <div className="bo-chips" aria-label="Active constraints">
        <span>Total Budget: {Number.isFinite(simulationBudget) ? amount(simulationBudget) : '—'}</span>
        <span>Max Change: ±{maxPctText || '—'}%</span>
        <span>{lockedCount} Locked</span><span>{excludedCount} Excluded</span><span>{customLimits} With Custom Limits</span>
        <span>Objective: {objectiveLabel[objective]}</span>
      </div>
    </section>

    <div className="bo-run">
      <button type="button" className="small-action primary-action bo-primary" disabled={!units.length} onClick={run}>Run Optimization</button>
      <button type="button" className="small-action" onClick={reset}><RotateCcw size={13} aria-hidden /> Reset Simulation</button>
      {stale && <span className="bo-stale" role="status">Inputs changed since the last run. Run the optimization again to update the results.</span>}
    </div>

    {result && !result.ok && <div className="bo-alert" role="alert"><b>Cannot run this simulation</b><span>{result.error}</span></div>}

    {good && good.ok && impact && <>
      <section className="panel"><div className="panel-head"><div><h2>Recommended Allocation</h2><p>Simulation only. Estimates use historical rates and are not guaranteed.</p></div><span className="mini-tag">{objectiveLabel[good.objective].toUpperCase()}</span></div>
        <div className="table-scroll bo-scroll"><table className="explorer-table"><thead><tr><th>{good.level === 'channel' ? 'Channel' : 'Campaign'}</th><th className="num">Current Budget</th><th className="num">Recommended Budget</th><th>Change</th><th className="num">Change %</th><th className="num">Current ROAS</th><th>Confidence</th><th>Risk</th><th className="bo-reason">Reason</th></tr></thead>
          <tbody>{good.rows.map((row) => <tr key={row.key}><td>{row.held === 'locked' && <Lock size={12} aria-label="Locked" />} {row.label}{row.held && <small>{row.held === 'locked' ? 'Locked' : 'Excluded'}</small>}</td><td className="num">{amount(row.current)}</td><td className="num">{amount(row.recommended)}</td><td><Direction change={row.change} /></td><td className="num">{Math.abs(row.change) < 0.005 ? '0.0%' : pct(row.changePct)}</td><td className="num">{roasFmt(row.roas)}</td><td>{row.confidence === 'Low' ? <span className="bo-tag warn">Limited data</span> : row.confidence}</td><td title={row.riskWhy}>{row.risk}<small>{row.riskWhy}</small></td><td className="bo-reason">{row.reason}</td></tr>)}</tbody>
          <tfoot><tr><td><b>Total</b></td><td className="num">{amount(impact.current_budget)}</td><td className="num">{amount(impact.recommended_budget)}</td><td colSpan={6} /></tr></tfoot></table></div>
      </section>

      <section className="panel"><div className="panel-head"><div><h2>Estimated Impact</h2><p>Current (observed) compared with Recommended (estimated). Simulation only.</p></div></div>
        <div className="table-scroll"><table className="explorer-table"><thead><tr><th>Measure</th><th className="num">Current</th><th className="num">Recommended (Estimated)</th><th className="num">Change</th></tr></thead><tbody>
          <tr><td>Total budget</td><td className="num">{amount(impact.current_budget)}</td><td className="num">{amount(impact.recommended_budget)}</td><td className="num">{signedAmount(impact.recommended_budget - impact.current_budget)}</td></tr>
          <tr><td>Revenue</td><td className="num">{amount(impact.current_revenue)}</td><td className="num">{amount(impact.est_revenue)}</td><td className="num">{signedAmount(impact.est_revenue - impact.current_revenue)} ({pct(impact.current_revenue > 0 ? ((impact.est_revenue - impact.current_revenue) / impact.current_revenue) * 100 : null)})</td></tr>
          <tr><td>Adjusted profit</td><td className="num">{amount(impact.current_profit)}</td><td className="num">{amount(impact.est_profit)}</td><td className="num">{signedAmount(impact.est_profit - impact.current_profit)}</td></tr>
          <tr><td>ROAS</td><td className="num">{roasFmt(impact.current_roas)}</td><td className="num">{roasFmt(impact.est_roas)}</td><td className="num">{roasFmt(impact.current_roas)} → {roasFmt(impact.est_roas)}</td></tr>
        </tbody></table></div>
      </section>

      <section className="panel"><div className="panel-head"><div><h2>Why These Changes?</h2><p>Basis for each recommended change. Locks, exclusions, limits and the budget total were applied before ranking.</p></div></div>
        {changedRows.length ? <ul className="bo-why">{changedRows.slice(0, 8).map((row) => <li key={row.key}><b>{row.label}</b> <Direction change={row.change} /><span>{row.reason}.</span><small>Risk: {row.risk} · {row.riskWhy}</small></li>)}</ul> : <p className="bo-hint">No change was recommended within the current constraints.</p>}
        {changedRows.length > 8 && <p className="bo-hint">Showing the 8 largest changes of {changedRows.length}.</p>}
      </section>
    </>}

    <section className="panel"><div className="panel-head"><div><h2>Save or Send</h2><p>Saving stores the scenario only. Sending creates an item for review in Decision Center; approval, rejection and rollback happen there.</p></div></div>
      <div className="bo-actions">
        <label className="bo-name">Scenario name<input value={name} maxLength={80} placeholder="Optional" onChange={(event) => setName(event.target.value)} /></label>
        <button type="button" className="small-action" disabled={busy || !good} onClick={() => void submit(false)}><Save size={13} aria-hidden /> Save Scenario</button>
        <button type="button" className="small-action primary-action" disabled={busy || !good || Boolean(saved?.sent && saved.signature === good?.signature)} onClick={() => void submit(true)}>Send to Decision Center <ArrowRight size={13} aria-hidden /></button>
      </div>
      {!good && <p className="bo-hint">Run the optimization first. Results must be current to save or send.</p>}
      {note && <div className={note.tone === 'error' ? 'bo-alert' : 'bo-ok'} role={note.tone === 'error' ? 'alert' : 'status'}><b>{note.title}</b><span>{note.text}</span>{note.tone === 'ok' && note.title.startsWith('Sent') && <button type="button" className="bo-link" onClick={() => onNavigate('decisions')}>Open Decision Center <ArrowRight size={12} aria-hidden /></button>}</div>}
      {scenarios.length > 0 && <div className="bo-saved"><h3>Saved Scenarios</h3>{scenarios.slice(0, 5).map((scenario) => <div key={scenario.id}><span><b>{scenario.name}</b><small>{objectiveLabel[scenario.objective as Objective] || scenario.objective} · budget {amount(scenario.total_budget)} · {formatDateTime(scenario.created_at, true)}</small></span><span className="bo-tag">{scenario.sent ? 'Sent for review' : 'Saved'}</span></div>)}</div>}
    </section>

    {showMethod && <div className="rb-overlay" role="presentation" onClick={() => setShowMethod(false)}><div className="rb-modal" role="dialog" aria-modal="true" aria-labelledby="bo-method" onClick={(event) => event.stopPropagation()}>
      <div className="rb-head"><h2 id="bo-method">How is this calculated?</h2><span className="mini-tag">SIMULATION</span></div>
      <ul className="bo-method">
        <li><b>Metrics used:</b> recorded spend, attributed revenue, return-adjusted profit and record counts. Inventory, volatility and anomalies are not used.</li>
        <li><b>Ranking:</b> each item is ranked by revenue (or adjusted profit) per unit of spend, blended toward the overall average when it has fewer than {PRIOR_RECORDS} records, so thin data cannot dominate.</li>
        <li><b>Constraints:</b> locked and excluded items keep their budget. Every other item may move by the maximum change you set (a quarter of that for limited-data items) unless you set your own minimum or maximum. Budget goes to the highest-ranked items first until limits or the total are reached.</li>
        <li><b>Estimates:</b> each moved amount is multiplied by that item&apos;s blended historical rate. Diminishing returns, seasonality and market changes are not modelled, so estimates are rough and future results are not guaranteed.</li>
        <li><b>Safety:</b> nothing is sent to an advertising platform. Sending to Decision Center only creates a review item.</li>
      </ul>
      <div className="rb-actions"><button type="button" className="small-action primary-action" onClick={() => setShowMethod(false)}>Close</button></div>
    </div></div>}
  </>;
}
