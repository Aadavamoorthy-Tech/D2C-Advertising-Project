'use client';

import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownToLine, ArrowLeft, ArrowRight, BarChart3, Bell, Check,
  ChevronDown, CircleHelp, CloudUpload, Command, Database, FileSpreadsheet,
  Gauge, Layers3, LoaderCircle, Moon, Orbit, RefreshCw, Search, Settings2,
  Sparkles, Sun, Target, TrendingUp, TriangleAlert, Upload, X,
} from 'lucide-react';

const API = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000').replace(/\/$/, '');

type Payload = Record<string, any>;
type Section =
  | 'overview' | 'campaigns' | 'insights' | 'data' | 'summary'
  | 'opportunities' | 'decisions' | 'optimizer' | 'inventory'
  | 'creatives' | 'execution' | 'learning' | 'copilot' | 'settings' | 'scenarios';

const navItems: { id: Section; label: string; group: string; icon: typeof Gauge }[] = [
  { id: 'overview', label: 'Command center', group: 'WORKSPACE', icon: Gauge },
  { id: 'data', label: 'Unified data hub', group: 'WORKSPACE', icon: Database },
  { id: 'campaigns', label: 'Performance Explorer', group: 'INTELLIGENCE', icon: BarChart3 },
  { id: 'insights', label: 'Anomaly & diagnosis', group: 'INTELLIGENCE', icon: TriangleAlert },
  { id: 'opportunities', label: 'Opportunity radar', group: 'INTELLIGENCE', icon: Target },
  { id: 'decisions', label: 'Decision center', group: 'DECISIONING', icon: Target },
  { id: 'optimizer', label: 'Budget optimizer', group: 'DECISIONING', icon: TrendingUp },
  { id: 'inventory', label: 'Inventory & margin', group: 'DECISIONING', icon: Layers3 },
  { id: 'creatives', label: 'Creative intelligence', group: 'DECISIONING', icon: Sparkles },
  { id: 'execution', label: 'Execution & audit', group: 'GOVERNANCE', icon: Check },
  { id: 'learning', label: 'Learning loop', group: 'GOVERNANCE', icon: Activity },
  { id: 'summary', label: 'AI data summary', group: 'GOVERNANCE', icon: Sparkles },
  { id: 'copilot', label: 'AI copilot', group: 'GOVERNANCE', icon: Command },
  { id: 'settings', label: 'Settings', group: 'SYSTEM', icon: Settings2 },
  { id: 'scenarios', label: 'Scenario guide', group: 'SYSTEM', icon: FileSpreadsheet },
];

function money(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, notation: 'compact' }).format(Number(value));
}
function number(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, notation: 'compact' }).format(Number(value));
}
function ratio(value: number | null | undefined) {
  return value == null ? 'Unavailable' : `${Number(value).toFixed(2)}×`;
}
function dateOnly(value: string | undefined) {
  return value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    const message = typeof detail === 'string' ? detail : detail?.message || data.message || `Request failed (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

function fullNumber(value: number | null | undefined, digits = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(Number(value));
}
function roasText(value: number | null | undefined) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Number(value).toFixed(2)}x`;
}

type SortKey = 'name' | 'spend' | 'revenue' | 'profit' | 'roas';
type SortState = { key: SortKey; dir: 'asc' | 'desc' };
const sortValue: Record<SortKey, (row: Payload) => number | string | null> = {
  name: (row) => String(row.campaign_id ?? row.channel ?? ''),
  spend: (row) => row.spend,
  revenue: (row) => row.attributed_revenue,
  profit: (row) => row.return_adjusted_net_profit,
  roas: (row) => row.roas,
};
function sortRows(rows: Payload[], sort: SortState) {
  const get = sortValue[sort.key];
  const factor = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : Number(x) - Number(y)) * factor;
  });
}

type TrendMetric = 'revenue' | 'spend' | 'profit' | 'roas';
const trendMetrics: { id: TrendMetric; label: string; color: string }[] = [
  { id: 'revenue', label: 'Revenue', color: 'var(--lime)' },
  { id: 'spend', label: 'Spend', color: '#6fb5e8' },
  { id: 'profit', label: 'Adjusted Profit', color: '#4fc58a' },
  { id: 'roas', label: 'ROAS', color: 'var(--amber)' },
];
const periodLabels: Record<number, string> = { 0: 'All time', 7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', 365: 'Last 12 months' };
const metricHelp = {
  revenue: 'Revenue attributed to advertising according to the supplied campaign data.',
  profit: 'Return-adjusted profit as supplied in the campaign data.',
  roas: 'ROAS = Attributed Revenue ÷ Ad Spend',
};

function Info({ text, label }: { text: string; label: string }) {
  return <button type="button" className="chart-info" title={text} aria-label={label}><CircleHelp size={13} /></button>;
}

function SortHead({ label, field, sort, onSort, info }: { label: string; field: SortKey; sort: SortState; onSort: (key: SortKey) => void; info?: string }) {
  const active = sort.key === field;
  return <th aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={field === 'name' ? '' : 'num'}>
    <button type="button" className={`sort-button ${active ? 'active' : ''}`} onClick={() => onSort(field)}>{label}<span aria-hidden="true">{active ? (sort.dir === 'asc' ? '↑' : '↓') : ''}</span></button>
    {info && <Info text={info} label={`About ${label}`} />}
  </th>;
}

function AreaLine({ values, color = 'var(--lime)' }: { values: number[]; color?: string }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const points = values.map((v, i) => {
    const y = span ? 92 - ((v - min) / span) * 80 : 52;
    return `${values.length <= 1 ? 50 : (i * 100) / (values.length - 1)},${y}`;
  }).join(' ');
  return <svg className="spark-svg" viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Recent daily performance trend">
    <polyline points={points} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    <polygon points={`0,100 ${points} 100,100`} fill="url(#trend-fill)" />
    <defs><linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1"><stop stopColor={color} stopOpacity=".22" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
  </svg>;
}

export default function Home() {
  const [section, setSection] = useState<Section>('overview');
  const [health, setHealth] = useState<Payload | null>(null);
  const [overview, setOverview] = useState<Payload | null>(null);
  const [campaigns, setCampaigns] = useState<Payload | null>(null);
  const [dataset, setDataset] = useState<Payload | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [recommendations, setRecommendations] = useState<Payload[]>([]);
  const [history, setHistory] = useState<Payload[]>([]);
  const [channels, setChannels] = useState<string[]>([]);
  const [channel, setChannel] = useState('');
  const [campaign, setCampaign] = useState('');
  const [campaignOptions, setCampaignOptions] = useState<string[]>([]);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('revenue');
  const [channelSort, setChannelSort] = useState<SortState>({ key: 'revenue', dir: 'desc' });
  const [campaignSort, setCampaignSort] = useState<SortState>({ key: 'revenue', dir: 'desc' });
  const [days, setDays] = useState(0);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [summary, setSummary] = useState<Payload | null>(null);
  const [light, setLight] = useState(false);

  const dateRange = useMemo(() => {
    if (!days) return { from: '', to: '' };
    const to = new Date();
    const from = new Date(to);
    from.setDate(to.getDate() - days + 1);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }, [days]);
  const filterQuery = useMemo(() => {
    const query = new URLSearchParams();
    if (dateRange.from) query.set('date_from', dateRange.from);
    if (dateRange.to) query.set('date_to', dateRange.to);
    if (channel) query.set('channel', channel);
    if (campaign && section === 'campaigns') query.set('campaign', campaign);
    return query.toString();
  }, [channel, dateRange, campaign, section]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [healthData, overviewData, statusData, filterData] = await Promise.all([
        request<Payload>('/api/health'),
        request<Payload>(`/api/overview?${filterQuery}`),
        request<Payload>('/api/datasets/status'),
        request<Payload>('/api/filters'),
      ]);
      setHealth(healthData);
      setOverview(overviewData);
      setDataset(statusData);
      setChannels(filterData.channels || []);
      setCampaignOptions(filterData.campaigns || []);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load dashboard data.');
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [filterQuery]);

  const loadCampaigns = useCallback(async () => {
    try {
      const query = new URLSearchParams(filterQuery);
      query.set('page_size', '100');
      const items: Payload[] = [];
      for (let current = 1; current <= 50; current += 1) {
        query.set('page', String(current));
        const data = await request<Payload>(`/api/campaigns?${query.toString()}`);
        items.push(...(data.items || []));
        if (!data.items?.length || items.length >= data.total) break;
      }
      setCampaigns({ items, total: items.length });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load campaign data.');
    }
  }, [filterQuery]);

  const loadDecisions = useCallback(async () => {
    try {
      const [recommendationData, historyData] = await Promise.all([
        request<Payload>('/api/recommendations'),
        request<Payload>('/api/decision-history'),
      ]);
      setRecommendations(recommendationData.items || []);
      setHistory(historyData.items || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load decision records.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (section === 'campaigns') void loadCampaigns(); }, [section, loadCampaigns]);
  useEffect(() => { if (section === 'decisions' || section === 'execution') void loadDecisions(); }, [section, loadDecisions]);
  useEffect(() => { document.body.dataset.theme = light ? 'light' : 'dark'; }, [light]);

  async function uploadCsv(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setMessage('');
    setError('');
    try {
      const body = new FormData();
      body.append('file', file);
      const result = await request<Payload>('/api/datasets/ingest', { method: 'POST', body });
      setDataset(result);
      setMessage(`${number(result.row_count)} records validated and uploaded.`);
      setFile(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload the CSV file.');
    } finally {
      setBusy(false);
    }
  }

  async function generateSummary() {
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      setSummary(await request<Payload>('/api/summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch_size: 500 }),
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI summary failed.');
    } finally {
      setBusy(false);
    }
  }

  async function changeDecision(id: string, action: 'approve' | 'reject' | 'simulate') {
    const reason = action === 'reject' ? window.prompt('Why are you rejecting this investigation item?') : '';
    if (action === 'reject' && !reason?.trim()) return;
    setBusy(true);
    setError('');
    try {
      await request<Payload>(`/api/recommendations/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || '' }),
      });
      await loadDecisions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save review decision.');
    } finally {
      setBusy(false);
    }
  }

  async function exportCampaigns() {
    try {
      const rows = visibleCampaigns;
      if (!rows.length) return;
      const columns = ['Campaign', 'SKU', 'Platform', 'Channel', 'Spend', 'Revenue', 'Adjusted Profit', 'ROAS'];
      const csv = [columns.join(','), ...rows.map((row: Payload) => [row.campaign_id, row.sku_id, row.ad_platform, row.channel, row.spend, row.attributed_revenue, row.return_adjusted_net_profit, row.roas].map((value) => JSON.stringify(value ?? '')).join(','))].join('\n');
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'adpilot-campaigns.csv';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not export campaign rows.');
    }
  }

  const metrics = overview?.metrics;
  const filtersActive = days !== 0 || Boolean(channel) || Boolean(campaign);
  const resetFilters = () => { setDays(0); setChannel(''); setCampaign(''); setSearch(''); setPage(1); };
  const trendRows: Payload[] = overview?.trend || [];
  const trendSeries = trendRows.map((item: Payload) => {
    if (trendMetric === 'roas') return item.spend ? Number(item.revenue || 0) / Number(item.spend) : 0;
    if (trendMetric === 'spend') return Number(item.spend || 0);
    if (trendMetric === 'profit') return Number(item.return_adjusted_profit || 0);
    return Number(item.revenue || 0);
  });
  const activeTrend = trendMetrics.find((item) => item.id === trendMetric) ?? trendMetrics[0];
  const formatTrend = (value: number) => (trendMetric === 'roas' ? roasText(value) : fullNumber(value));
  const sortedChannels = useMemo(() => sortRows(overview?.channels || [], channelSort), [overview, channelSort]);
  const channelMax = Math.max(0, ...sortedChannels.map((row) => Math.abs(Number(sortValue[channelSort.key === 'name' ? 'revenue' : channelSort.key](row)) || 0)));
  const visibleCampaigns = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows: Payload[] = campaigns?.items || [];
    const filtered = term ? rows.filter((row) => [row.campaign_id, row.sku_id, row.ad_platform, row.channel].some((value) => String(value ?? '').toLowerCase().includes(term))) : rows;
    return sortRows(filtered, campaignSort);
  }, [campaigns, search, campaignSort]);
  const campaignPageSize = 15;
  const campaignPages = Math.max(1, Math.ceil(visibleCampaigns.length / campaignPageSize));
  const campaignPage = Math.min(page, campaignPages);
  const pagedCampaigns = visibleCampaigns.slice((campaignPage - 1) * campaignPageSize, campaignPage * campaignPageSize);
  const toggleSort = (setter: (value: SortState | ((current: SortState) => SortState)) => void) => (key: SortKey) => {
    setter((current) => ({ key, dir: current.key === key && current.dir === 'desc' ? 'asc' : 'desc' }));
    setPage(1);
  };
  const trendValues = (overview?.trend || []).map((item: Payload) => Number(item.revenue || 0));
  const sourceLabel = health?.mode === 'demo' ? 'CSV demo' : 'Exasol';
  const sourceStatus = loading
    ? 'Checking'
    : health?.mode === 'demo'
      ? 'Demo'
      : health?.status === 'ok'
        ? 'Connected'
        : 'Offline';
  const dataHealthStatus = loading
    ? 'Checking'
    : health?.status !== 'ok'
      ? 'Unavailable'
      : Number(overview?.quality?.duplicate_ids || 0) > 0
        ? 'Data quality issue detected'
      : dataset?.status === 'ready' || dataset?.status === 'fixture'
        ? 'Healthy'
        : 'No dataset';
  const quality = overview?.quality;
  const missingRequiredValues = quality?.missing_required_values;
  const missingValueCount = missingRequiredValues && typeof missingRequiredValues === 'object'
    ? Object.values(missingRequiredValues).reduce((total: number, value) => total + Number(value || 0), 0)
    : null;
  const missingFieldCount = missingRequiredValues && typeof missingRequiredValues === 'object'
    ? Object.values(missingRequiredValues).filter((value) => Number(value) > 0).length
    : null;
  const duplicateRecordCount = typeof quality?.duplicate_ids === 'number' ? quality.duplicate_ids : null;
  const qualityChecked = duplicateRecordCount !== null && missingValueCount !== null;
  const currencyNotConfigured = Boolean(quality?.currency_note);
  const dataQualityStatus = loading
    ? 'Checking'
    : !qualityChecked
      ? 'Not checked'
      : duplicateRecordCount > 0 || missingValueCount > 0 || currencyNotConfigured
        ? 'Needs Attention'
        : 'Healthy';
  const dataQualitySummary = !qualityChecked
    ? 'Quality checks are not available.'
    : duplicateRecordCount > 0
      ? `${number(duplicateRecordCount)} duplicate records detected.`
      : missingValueCount > 0
        ? `${number(missingFieldCount)} required ${missingFieldCount === 1 ? 'field contains' : 'fields contain'} missing values.`
        : currencyNotConfigured
          ? 'Currency is not configured in the source data.'
          : 'No major data-quality issues detected.';
  const dataSourceName = health?.mode === 'live'
    ? 'Exasol'
    : dataset?.status === 'ready'
      ? 'Uploaded CSV'
      : health?.mode === 'demo'
        ? 'Demo Dataset'
        : 'Unavailable';
  const connectionStatus = loading ? 'Checking' : health?.status === 'ok' ? 'Connected' : 'Disconnected';
  const dataUpdatedAt = dataset?.ingested_at ? new Date(dataset.ingested_at) : lastUpdated;
  const trendDates = (overview?.trend || []).map((item: Payload) => item.date).filter(Boolean);
  const dataRange = trendDates.length
    ? `${dateOnly(trendDates[0])} – ${dateOnly(trendDates[trendDates.length - 1])}`
    : 'Not checked';

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand-row"><div className="brand-mark"><Orbit size={18} /></div><b>ADPILOT</b><span className="beta">LAB</span></div>
      <button className="brand-switch"><span className="avatar">L</span><span><b>Lumière Skin Co.</b><small>D2C workspace</small></span><ChevronDown size={14} /></button>
      <button className="quick-search" onClick={() => document.getElementById('campaign-search')?.focus()}><Search size={15} /><span>Quick search</span><kbd>⌘ K</kbd></button>
      <nav className="nav" aria-label="Dashboard sections">
        {['WORKSPACE', 'INTELLIGENCE', 'DECISIONING', 'GOVERNANCE', 'SYSTEM'].map((group) => <div className="nav-group" key={group}>
          <div className="nav-label">{group}</div>
          {navItems.filter((item) => item.group === group).map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={`nav-link ${section === item.id ? 'active' : ''}`} onClick={() => { setSection(item.id); setError(''); }}><Icon size={16} /><span>{item.label}</span>{item.id === 'summary' && <i className="ai-dot" />}</button>;
          })}
        </div>)}
      </nav>
    </aside>

    <main className="main-column">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><span>/</span><b>{navItems.find((item) => item.id === section)?.label}</b></div>
        <div className="topbar-actions">
          {section !== 'campaigns' && <><label className="select-group"><small>Period</small><select value={days} onChange={(event) => setDays(Number(event.target.value))}><option value={0}>All time</option><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option><option value={365}>Last 12 months</option></select></label>
          <label className="select-group"><small>Channel</small><select value={channel} onChange={(event) => setChannel(event.target.value)}><option value="">All channels</option>{channels.map((name) => <option key={name} value={name}>{name}</option>)}</select></label></>}
          <button className="icon-button" title={light ? 'Switch to dark theme' : 'Switch to light theme'} onClick={() => setLight(!light)}>{light ? <Moon size={16} /> : <Sun size={16} />}</button>
          {section === 'campaigns' ? null : section === 'data' ? <button className="icon-button data-refresh" onClick={() => void refresh()} disabled={loading} title="Refresh Data" aria-label="Refresh Data"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button> : <div className="data-status" aria-label="Data source status">
            <span className="data-status-source">
              <span className={`health-dot ${loading ? 'checking' : health?.status === 'ok' ? '' : 'offline'}`} />
              Data source: <strong>{sourceLabel}</strong>
              <span className={`data-status-state ${sourceStatus.toLowerCase()}`}>{sourceStatus}</span>
            </span>
            <span className="data-status-time">Last updated: {lastUpdated ? lastUpdated.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</span>
            <button className="icon-button data-refresh" onClick={() => void refresh()} disabled={loading} title="Refresh data" aria-label="Refresh data">
              <RefreshCw size={14} className={loading ? 'spin' : ''} />
            </button>
          </div>}
        </div>
      </header>

      <section className={`content ${section === 'data' ? 'data-hub' : ''}`}>
        {error && <div className="notice error" role="alert"><TriangleAlert size={16} /><span>{error}</span><button onClick={() => void refresh()} aria-label="Retry"><RefreshCw size={14} /> Retry</button></div>}
        {message && <div className="notice success" role="status"><Check size={16} />{message}<button onClick={() => setMessage('')} aria-label="Dismiss"><X size={14} /></button></div>}

        {section === 'overview' && <>
          <div className="page-heading"><div><div className="eyebrow">Last updated: {lastUpdated ? lastUpdated.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</div><h1>Campaign performance overview</h1><p>Monitor advertising performance and compare results across your channels.</p></div></div>
          {loading ? <div className="state-card"><LoaderCircle className="spin" />Loading campaign data…</div> : metrics && <div className="stats-grid">
            <Stat icon={<BarChart3 size={16} />} label="Total ad spend" value={money(metrics.spend)} note="Observed · currency unspecified" />
            <Stat icon={<TrendingUp size={16} />} label="Attributed revenue" value={money(metrics.attributed_revenue)} note="Not reconciled · currency unspecified" />
            <Stat icon={<Target size={16} />} label="Return-adjusted profit" value={money(metrics.return_adjusted_net_profit)} note="Dataset measure · currency unspecified" />
            <Stat icon={<Gauge size={16} />} label="Blended ROAS" value={ratio(metrics.roas)} note="Aggregate attributed revenue / spend" />
            <Stat icon={<Activity size={16} />} label="Conversions" value={number(metrics.conversions)} note="Observed records in selected window" />
            <Stat icon={<TrendingUp size={16} />} label="Cost per conversion" value={money(metrics.cpa, 2)} note="Total spend / total conversions" />
          </div>}
          <div className="dashboard-grid">
            <section className="panel pulse-panel"><div className="panel-head"><div><h2>Performance Trend</h2><p className="chart-metric">Attributed Revenue <button type="button" className="chart-info" title="Revenue values are taken from the supplied campaign dataset and may differ from reconciled business revenue." aria-label="About attributed revenue"><CircleHelp size={13} /></button></p></div></div>
              {trendValues.length ? <div className="chart-wrap"><AreaLine values={trendValues} /><div className="chart-foot"><span>{dateOnly(overview?.trend?.[0]?.date)}</span><span>{dateOnly(overview?.trend?.[overview.trend.length - 1]?.date)}</span></div></div> : <Empty text={error || 'No trend records for this filter.'} />}
            </section>
            <section className="panel source-panel data-health-panel"><div className="panel-head"><div><h2>Data Health</h2></div><Database size={17} /></div>
              <div className="data-health-content">
                <strong className={`data-health-status ${dataHealthStatus.toLowerCase().replace(/\s+/g, '-')}`}>{dataHealthStatus}</strong>
                <div className="data-health-detail"><span>Source</span><b>{health?.mode === 'live' ? 'Exasol' : dataset?.status === 'ready' ? 'Uploaded CSV' : 'Demo Dataset'}</b></div>
                <div className="data-health-detail"><span>Last updated</span><b>{lastUpdated ? lastUpdated.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</b></div>
                <button type="button" className="data-health-link" onClick={() => { setSection('data'); setError(''); }}>View details <ArrowRight size={13} /></button>
              </div>
            </section>
          </div>
          <section className="panel channel-panel"><div className="panel-head"><div><h2>Channel performance</h2><p>Compare advertising performance across channels.</p></div><span className="mini-tag">{overview?.channels?.length || 0} CHANNELS</span></div>
            <div className="table-scroll"><table><thead><tr><th>CHANNEL</th><th>RECORDS</th><th>SPEND</th><th>ATTRIBUTED REVENUE</th><th>RETURN-ADJUSTED PROFIT</th><th>ROAS</th></tr></thead><tbody>{(overview?.channels || []).map((item: Payload) => <tr key={item.channel}><td><b>{item.channel}</b></td><td>{number(item.record_count)}</td><td>{money(item.spend)}</td><td>{money(item.attributed_revenue)}</td><td>{money(item.return_adjusted_net_profit)}</td><td><span className="roas">{ratio(item.roas)}</span></td></tr>)}</tbody></table></div>
          </section>
          <div className="notice neutral"><CircleHelp size={15} /><span>No inferred causes, automated budget allocations, or live ad-account changes are generated. This dashboard reports the supplied metrics and summarizes them with AI on request.</span></div>
        </>}

        {section === 'campaigns' && <>
          <div className="page-heading"><div><h1>Performance Explorer</h1><p>Analyze campaign performance across time, channels and campaigns.</p></div><div className="explorer-meta"><span>Last updated: {lastUpdated ? lastUpdated.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</span><button className="secondary-button" onClick={() => void exportCampaigns()} disabled={!visibleCampaigns.length}><ArrowDownToLine size={15} /> Export CSV</button></div></div>
          <div className="explorer-filters">
            <label><span>Period</span><select value={days} onChange={(event) => { setDays(Number(event.target.value)); setPage(1); }}>{Object.entries(periodLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label><span>Channel</span><select value={channel} onChange={(event) => { setChannel(event.target.value); setPage(1); }}><option value="">All channels</option>{channels.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            <label><span>Campaign</span><select value={campaign} onChange={(event) => { setCampaign(event.target.value); setPage(1); }}><option value="">All campaigns</option>{campaignOptions.map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            {filtersActive && <div className="filter-chips">
              {days !== 0 && <button type="button" onClick={() => setDays(0)}>{periodLabels[days]} <X size={11} /></button>}
              {channel && <button type="button" onClick={() => setChannel('')}>{channel} <X size={11} /></button>}
              {campaign && <button type="button" onClick={() => setCampaign('')}>{campaign} <X size={11} /></button>}
              <button type="button" className="reset-filters" onClick={resetFilters}>Reset filters</button>
            </div>}
          </div>
          {metrics && <div className="explorer-kpis">
            <div><span>Spend</span><strong>{fullNumber(metrics.spend)}</strong></div>
            <div><span>Revenue <Info text={metricHelp.revenue} label="About revenue" /></span><strong>{fullNumber(metrics.attributed_revenue)}</strong></div>
            <div><span>Adjusted Profit <Info text={metricHelp.profit} label="About adjusted profit" /></span><strong>{fullNumber(metrics.return_adjusted_net_profit)}</strong></div>
            <div><span>ROAS <Info text={metricHelp.roas} label="About ROAS" /></span><strong>{roasText(metrics.roas)}</strong></div>
          </div>}
          <section className="panel explorer-panel explorer-trend"><div className="panel-head"><div><h2>Performance Over Time</h2></div>
            <div className="metric-tabs" role="tablist" aria-label="Metric">{trendMetrics.map((item) => <button key={item.id} type="button" role="tab" aria-selected={trendMetric === item.id} className={trendMetric === item.id ? 'active' : ''} onClick={() => setTrendMetric(item.id)}>{item.label}</button>)}</div></div>
            {trendSeries.length ? <div className="chart-wrap explorer-chart"><AreaLine values={trendSeries} color={activeTrend.color} /><div className="chart-foot"><span>{dateOnly(trendRows[0]?.date)}</span><span>Peak {formatTrend(Math.max(...trendSeries))}</span><span>{dateOnly(trendRows[trendRows.length - 1]?.date)}</span></div></div> : <Empty text={error || 'No trend records for this filter.'} />}
          </section>
          <section className="panel explorer-panel"><div className="panel-head"><div><h2>Channel Comparison</h2></div></div>
            <div className="table-scroll"><table className="explorer-table"><thead><tr><SortHead label="Channel" field="name" sort={channelSort} onSort={toggleSort(setChannelSort)} /><SortHead label="Spend" field="spend" sort={channelSort} onSort={toggleSort(setChannelSort)} /><SortHead label="Revenue" field="revenue" sort={channelSort} onSort={toggleSort(setChannelSort)} info={metricHelp.revenue} /><SortHead label="Adjusted Profit" field="profit" sort={channelSort} onSort={toggleSort(setChannelSort)} info={metricHelp.profit} /><SortHead label="ROAS" field="roas" sort={channelSort} onSort={toggleSort(setChannelSort)} info={metricHelp.roas} /></tr></thead>
              <tbody>{sortedChannels.length ? sortedChannels.map((item: Payload) => {
                const bar = (field: SortKey, text: string) => {
                  const raw = Number(sortValue[field](item)) || 0;
                  const width = channelSort.key === field && channelMax ? Math.max(2, (Math.abs(raw) / channelMax) * 100) : 0;
                  return <td className="num"><span>{text}</span>{width > 0 && <i className="bar" style={{ width: `${width}%` }} />}</td>;
                };
                return <tr key={item.channel}><td><b>{item.channel}</b></td>{bar('spend', fullNumber(item.spend))}{bar('revenue', fullNumber(item.attributed_revenue))}{bar('profit', fullNumber(item.return_adjusted_net_profit))}{bar('roas', roasText(item.roas))}</tr>;
              }) : <tr><td colSpan={5} className="table-empty">No channels for this filter.</td></tr>}</tbody></table></div>
          </section>
          <section className="panel explorer-panel campaign-panel"><div className="panel-head"><div><h2>Campaign Performance</h2></div><span className="result-count">{fullNumber(visibleCampaigns.length)} campaigns</span></div>
            {(campaigns?.items?.length || 0) > campaignPageSize && <div className="toolbar"><label className="search-box"><Search size={15} /><input id="campaign-search" value={search} onChange={(event) => { setPage(1); setSearch(event.target.value); }} placeholder="Search campaigns" /></label></div>}
            {campaigns ? <div className="table-scroll"><table className="explorer-table"><thead><tr><SortHead label="Campaign" field="name" sort={campaignSort} onSort={toggleSort(setCampaignSort)} /><th>Channel</th><SortHead label="Spend" field="spend" sort={campaignSort} onSort={toggleSort(setCampaignSort)} /><SortHead label="Revenue" field="revenue" sort={campaignSort} onSort={toggleSort(setCampaignSort)} info={metricHelp.revenue} /><SortHead label="Adjusted Profit" field="profit" sort={campaignSort} onSort={toggleSort(setCampaignSort)} info={metricHelp.profit} /><SortHead label="ROAS" field="roas" sort={campaignSort} onSort={toggleSort(setCampaignSort)} info={metricHelp.roas} /></tr></thead>
              <tbody>{pagedCampaigns.length ? pagedCampaigns.map((row: Payload) => <tr key={`${row.campaign_id}-${row.sku_id}-${row.ad_platform}`}><td><b>{row.campaign_id}</b><small>{row.sku_id}</small></td><td>{row.channel}</td><td className="num">{fullNumber(row.spend)}</td><td className="num">{fullNumber(row.attributed_revenue)}</td><td className="num">{fullNumber(row.return_adjusted_net_profit)}</td><td className="num">{roasText(row.roas)}</td></tr>) : <tr><td colSpan={6} className="table-empty">No campaigns for this filter.</td></tr>}</tbody></table></div> : <div className="state-card"><LoaderCircle className="spin" />Loading campaigns…</div>}
            <div className="pagination"><span>Metrics are based on supplied campaign data.</span><div><button disabled={campaignPage <= 1} onClick={() => setPage(campaignPage - 1)}><ArrowLeft size={14} /> Previous</button><span>Page {campaignPage} of {campaignPages}</span><button disabled={campaignPage >= campaignPages} onClick={() => setPage(campaignPage + 1)}>Next <ArrowRight size={14} /></button></div></div>
          </section></>}

        {section === 'insights' && <><div className="page-heading"><div><div className="eyebrow">VERIFIED OBSERVATIONS</div><h1>Anomaly & diagnosis</h1><p>Observed metrics only. Changes do not establish their cause.</p></div></div>
          <section className="panel"><div className="panel-head"><div><h2>Data observations</h2><p>Calculated from the filtered records</p></div><Activity size={17} /></div>
            {metrics ? <div className="observations"><Observation title="Click-through rate" value={metrics.ctr == null ? 'Unavailable' : `${(metrics.ctr * 100).toFixed(2)}%`} detail="Calculated as sum of estimated clicks / sum of impressions." />
              <Observation title="Cost per click" value={money(metrics.cpc, 2)} detail="Calculated as total spend / total estimated clicks." />
              <Observation title="Conversion rate" value={metrics.cvr == null ? 'Unavailable' : `${(metrics.cvr * 100).toFixed(2)}%`} detail="Calculated as total conversions / total estimated clicks." />
              <Observation title="Return-adjusted profit" value={money(metrics.return_adjusted_net_profit)} detail="Provided by the CSV; this view does not infer profitability from revenue minus spend." />
              <Observation title="Evidence limitation" value="No causal conclusion" detail="The dataset has no comparison design that can show why a metric changed." /></div> : <Empty text={error || 'Load a dataset to see observations.'} />}
          </section><div className="notice neutral"><CircleHelp size={15} /><span>AI is restricted to summaries in this version. It does not diagnose root causes or generate recommendations.</span></div></>}

        {section === 'data' && <>
          <div className="page-heading data-hub-heading">
            <div><h1>Unified Data Hub</h1><p>Review connected data sources, dataset structure and data quality.</p></div>
          </div>
          <section className="panel data-source-summary">
            <div className="panel-head"><div><h2>Data Source</h2></div><Database size={17} /></div>
            <div className="data-source-grid">
              <div><span>Source</span><strong>{dataSourceName}</strong></div>
              <div><span>Status</span><strong className={connectionStatus === 'Connected' ? 'data-value-healthy' : 'data-value-warning'}>{connectionStatus}</strong></div>
              <div><span>Last Updated</span><strong>{dataUpdatedAt ? dataUpdatedAt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</strong></div>
              <div><span>Total Records</span><strong>{dataset?.row_count == null ? 'Not available' : number(dataset.row_count)}</strong></div>
            </div>
          </section>
          <div className="data-hub-layout">
            <section className="panel data-quality-panel">
              <div className="panel-head"><div><h2>Data Quality</h2><p>Quality checks for the current data view</p></div></div>
              <div className="data-quality-overview">
                <span className={`data-quality-status ${dataQualityStatus.toLowerCase().replace(/\s+/g, '-')}`}>{dataQualityStatus}</span>
                <p>{dataQualitySummary}</p>
              </div>
              <div className="data-quality-grid">
                <div><span>Filtered Records</span><strong>{quality?.rows == null ? 'Not checked' : number(quality.rows)}</strong></div>
                <div><span>Duplicate Records</span><strong>{duplicateRecordCount == null ? 'Not checked' : number(duplicateRecordCount)}</strong></div>
                <div><span>Missing Values</span><strong>{missingValueCount == null ? 'Not checked' : number(missingValueCount)}</strong></div>
                <div><span>Date Range</span><strong>{dataRange}</strong></div>
                <div><span>Currency</span><strong className={currencyNotConfigured ? 'data-value-warning' : ''}>{currencyNotConfigured ? 'Not configured' : 'Not checked'}</strong></div>
              </div>
              {missingRequiredValues && Object.entries(missingRequiredValues).some(([, value]) => Number(value) > 0) && <div className="data-quality-notes">
                {Object.entries(missingRequiredValues).filter(([, value]) => Number(value) > 0).map(([field, count]) => <div key={field}>{field.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())}: {number(Number(count))} missing</div>)}
              </div>}
              {dataset && Array.isArray(dataset.warnings) && dataset.warnings.length > 0 && <details className="data-quality-disclosure">
                <summary>Data Notes ({dataset.warnings.length})</summary>
                <ul>{dataset.warnings.map((warning: string) => <li key={warning}>{warning}</li>)}</ul>
              </details>}
            </section>
            <section className="panel data-upload-panel">
              <div className="panel-head"><div><h2>Manage Data</h2><p>Upload a campaign CSV to replace the current dataset.</p></div><CloudUpload size={18} /></div>
              <form className="upload-form" onSubmit={(event) => void uploadCsv(event)}>
                <label className="dropzone"><FileSpreadsheet size={20} /><b>{file?.name || 'Choose a CSV file'}</b><small>CSV files only</small><input type="file" accept=".csv,text/csv" onChange={(event: ChangeEvent<HTMLInputElement>) => setFile(event.target.files?.[0] || null)} /></label>
                <button className="sync-button" disabled={!file || busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}{busy ? 'Uploading…' : 'Upload CSV'}</button>
              </form>
            </section>
          </div>
        </>}

        {section === 'summary' && <><div className="page-heading"><div><div className="eyebrow">AI · SUMMARIZATION ONLY</div><h1>Dataset summary</h1><p>The AI describes patterns in the data. It does not diagnose causes or recommend actions.</p></div><button className="sync-button" onClick={() => void generateSummary()} disabled={busy || !overview}><Sparkles size={15} />{busy ? 'Summarizing…' : 'Summarize all rows'}</button></div>
          <section className="panel summary-panel"><div className="panel-head"><div><h2>Summarize complete dataset</h2><p>When Gemini is configured, campaign data is summarized in batches of 500 rows. Personal demographics and payment fields are excluded. Without an API key, deterministic descriptive totals are shown instead.</p></div><Command size={17} /></div>
            {busy ? <div className="state-card"><LoaderCircle className="spin" />Sending dataset batches for summaries. This may take several minutes…</div> : summary ? <><div className="summary-meta"><span className={`status-tag ${summary.status === 'fallback' ? 'amber' : 'green'}`}>{summary.status === 'fallback' ? 'DETERMINISTIC FALLBACK · NO AI' : 'AI SUMMARY COMPLETE'}</span><span>{number(summary.rows_summarized)} rows · {summary.status === 'fallback' ? 'AI unavailable' : `${summary.batch_count} batches · ${summary.model}`}</span></div>{summary.status_message && <p className="panel-foot">{summary.status_message}</p>}<article className="summary-copy">{summary.summary}</article></> : <Empty text={overview ? 'Run a summary to get a concise overview of all loaded campaign records.' : 'Load campaign data before requesting a summary.'} />}
          </section><div className="notice neutral"><CircleHelp size={15} /><span>When configured, Gemini receives campaign data required for summarization. Do not include confidential data unless your organization permits it. AI output is descriptive, not a validated numerical source of truth; the no-key fallback is not model-generated.</span></div></>}
        {section === 'decisions' && <><div className="page-heading"><div><div className="eyebrow">RULE-BASED REVIEW · NO SPEND CHANGES</div><h1>Decision center</h1><p>Review transparent investigation candidates generated from observed metrics.</p></div></div>
          <section className="panel"><div className="panel-head"><div><h2>Investigation candidates</h2><p>Rule: at least five records and negative return-adjusted profit for a campaign/SKU group.</p></div><span className="mini-tag">{recommendations.length} CANDIDATES</span></div>
            {recommendations.length ? recommendations.map((item) => <div className="decision-row" key={item.id}><div className="decision-copy"><b>{item.title}</b><small>{item.channel} · {item.ad_platform} · {item.evidence.record_count} records</small><p>Observed return-adjusted profit: <strong>{money(item.evidence.return_adjusted_net_profit)}</strong>. This flags a review; it does not establish cause or estimate impact.</p><small>Rule {item.evidence.rule_id} · dataset {item.dataset_id.slice(0, 10)}</small></div><span className={`status-tag ${item.status === 'proposed' ? 'amber' : 'green'}`}>{item.status.toUpperCase()}</span><div className="decision-actions">{item.status === 'proposed' ? <><button className="small-action primary-action" disabled={busy} onClick={() => void changeDecision(item.id, 'approve')}>Approve review</button><button className="small-action" disabled={busy} onClick={() => void changeDecision(item.id, 'reject')}>Reject</button></> : item.status === 'approved' ? <button className="small-action" disabled={busy} onClick={() => void changeDecision(item.id, 'simulate')}>Mark investigation simulated</button> : <span className="decision-note">No ad account action</span>}</div></div>) : <Empty text={overview ? 'No campaign/SKU groups met the documented investigation rule.' : 'Load a dataset to evaluate the rule.'} />}
          </section><div className="notice neutral"><CircleHelp size={15} /><span>Approving means a human approved an investigation item. Simulation only records the review workflow; it never changes campaign spend.</span></div></>}
        {section === 'execution' && <><div className="page-heading"><div><div className="eyebrow">AUDIT TRAIL</div><h1>Decision history</h1><p>Recorded approvals, rejections, and simulation states. No live advertising execution is available.</p></div></div><section className="panel"><div className="panel-head"><div><h2>Review events</h2><p>Persistent local decision metadata</p></div></div>{history.length ? history.map((event, index) => <div className="quality-row" key={`${event.decision_id}-${event.created_at}-${index}`}><span><b>{event.target}</b><small>{new Date(event.created_at).toLocaleString()} · {event.reason || 'No note'}</small></span><span className="status-tag green">{event.status}</span></div>) : <Empty text="Review decisions will appear here." />}</section></>}
        {!['overview', 'campaigns', 'insights', 'data', 'summary', 'decisions', 'execution'].includes(section) && <><div className="page-heading"><div><div className="eyebrow">ADPILOT WORKSPACE</div><h1>{navItems.find((item) => item.id === section)?.label}</h1><p>This screen is reserved for a future workflow; no unsupported analytics are shown.</p></div></div><section className="panel"><Empty text="This local MVP currently provides verified campaign metrics, rule-based investigation candidates, human review history, and AI-generated summaries. It does not generate budget allocations or execute live ad-account changes." /></section></>}
      </section>
    </main>
  </div>;
}

function Stat({ icon, label, value, note }: { icon: React.ReactNode; label: string; value: string; note: string }) {
  return <div className="stat-card"><div className="stat-top"><span>{label}</span><span className="stat-icon">{icon}</span></div><strong>{value}</strong><div className="stat-note">{note}</div></div>;
}
function QualityRow({ label, value, warning = false }: { label: string; value: string | number; warning?: boolean }) {
  return <div className="quality-row"><span>{label}</span><b className={warning ? 'text-amber' : ''}>{value}</b></div>;
}
function Observation({ title, value, detail }: { title: string; value: string; detail: string }) {
  return <div className="observation"><span className="observation-icon"><Activity size={15} /></span><div><b>{title}</b><p>{detail}</p></div><strong>{value}</strong></div>;
}
function Empty({ text }: { text: string }) {
  return <div className="empty-state"><span>◌</span><b>No data to display</b><p>{text}</p></div>;
}
