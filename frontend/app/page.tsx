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
  { id: 'overview', label: 'Action Center', group: 'WORKSPACE', icon: Gauge },
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

type Priority = 'High' | 'Medium' | 'Low';
type ActionItem = { key: string; category: string; title: string; text: string; metric?: string; priority?: Priority; target: Section; cta: string };
const priorityRank: Record<Priority, number> = { High: 0, Medium: 1, Low: 2 };

function PriorityBadge({ level }: { level: Priority }) {
  const Icon = level === 'High' ? TriangleAlert : level === 'Medium' ? Activity : Bell;
  return <span className={`priority ${level.toLowerCase()}`}><Icon size={11} />{level}</span>;
}
function ActionCard({ item, onGo }: { item: ActionItem; onGo: (target: Section) => void }) {
  return <div className="ac-item">
    <div className="ac-item-main">
      <div className="ac-item-meta"><span>{item.category}</span>{item.priority && <PriorityBadge level={item.priority} />}</div>
      <b>{item.title}</b>
      <p>{item.text}</p>
      {item.metric && <small>{item.metric}</small>}
    </div>
    <button type="button" className="ac-link" onClick={() => onGo(item.target)}>{item.cta} <ArrowRight size={12} /></button>
  </div>;
}

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
  const [decisionsReady, setDecisionsReady] = useState(false);
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
      setDecisionsReady(true);
    } catch (err) {
      setDecisionsReady(false);
      setError(err instanceof Error ? err.message : 'Could not load decision records.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (section === 'campaigns' || section === 'opportunities' || section === 'overview') void loadCampaigns(); }, [section, loadCampaigns]);
  useEffect(() => { if (section === 'decisions' || section === 'execution' || section === 'overview') void loadDecisions(); }, [section, loadDecisions]);
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
  const radar = useMemo(() => {
    const groups: Payload[] = (campaigns?.items || []).filter((row: Payload) => row.spend != null && row.roas != null && Number(row.spend) > 0);
    const blended = Number(overview?.metrics?.roas);
    if (!groups.length || !Number.isFinite(blended) || blended <= 0) return null;
    const spends = groups.map((row) => Number(row.spend)).sort((a, b) => a - b);
    const medianSpend = spends[Math.floor(spends.length / 2)];
    const material = groups.filter((row) => Number(row.spend) >= medianSpend);
    const highRoas = material.filter((row) => Number(row.roas) >= blended * 1.2).sort((a, b) => Number(b.roas) - Number(a.roas)).slice(0, 5);
    const gaps = material.filter((row) => Number(row.roas) <= blended * 0.8).sort((a, b) => (Number(b.spend) - Number(b.attributed_revenue || 0)) - (Number(a.spend) - Number(a.attributed_revenue || 0))).slice(0, 5);
    const ranked = ((overview?.channels || []) as Payload[]).filter((row) => row.roas != null && Number(row.spend) > 0).sort((a, b) => Number(b.roas) - Number(a.roas));
    const from = ranked.length > 1 ? ranked[ranked.length - 1] : null;
    const to = ranked.length > 1 ? ranked[0] : null;
    const realloc = from && to && Number(to.roas) > Number(from.roas) ? { from, to } : null;
    const days: Payload[] = overview?.trend || [];
    const values = days.map((day) => Number(day.revenue || 0));
    const mean = values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
    const deviation = Math.sqrt(values.reduce((total, value) => total + (value - mean) ** 2, 0) / (values.length || 1));
    const unusual = deviation > 0
      ? days.map((day, index) => ({ date: day.date, revenue: values[index], z: (values[index] - mean) / deviation })).filter((day) => Math.abs(day.z) >= 2).sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3)
      : [];
    return { blended, medianSpend, highRoas, gaps, realloc, unusual, mean };
  }, [campaigns, overview]);
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

  const goTo = (target: Section) => { setSection(target); setError(''); };
  const clock = (value: Date) => value.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const pendingDecisions: Payload[] = recommendations.filter((item) => item.status === 'proposed');
  const trendDays: Payload[] = overview?.trend || [];
  const lastDay = trendDays.length ? new Date(trendDays[trendDays.length - 1].date).getTime() : null;
  const roasChange = (() => {
    if (lastDay === null) return null;
    const span = 30 * 86400000;
    const totals = (from: number, to: number) => trendDays.reduce((sum, day) => {
      const time = new Date(day.date).getTime();
      return time > from && time <= to ? { spend: sum.spend + Number(day.spend || 0), revenue: sum.revenue + Number(day.revenue || 0) } : sum;
    }, { spend: 0, revenue: 0 });
    const recent = totals(lastDay - span, lastDay);
    const previous = totals(lastDay - 2 * span, lastDay - span);
    if (recent.spend <= 0 || previous.spend <= 0 || previous.revenue <= 0) return null;
    const recentRoas = recent.revenue / recent.spend;
    const previousRoas = previous.revenue / previous.spend;
    return { recent: recentRoas, previous: previousRoas, pct: ((recentRoas - previousRoas) / previousRoas) * 100 };
  })();
  const dataWarning = qualityChecked && (Number(duplicateRecordCount) > 0 || Number(missingValueCount) > 0);
  const totalSpend = Number(metrics?.spend) || 0;
  const roasMetric = roasChange ? `ROAS ${roasText(roasChange.previous)} → ${roasText(roasChange.recent)}` : undefined;
  const roasDropPriority: Priority = roasChange && roasChange.pct <= -25 ? 'High' : 'Medium';

  const attentionItems: ActionItem[] = [];
  if (roasChange && roasChange.pct <= -10) attentionItems.push({ key: 'roas', category: 'Performance Warning', title: 'ROAS decline detected', text: 'Possible issue: ROAS is lower than in the previous 30 days of data.', metric: roasMetric, priority: roasDropPriority, target: 'campaigns', cta: 'Investigate' });
  if (metrics && Number(metrics.return_adjusted_net_profit) < 0) attentionItems.push({ key: 'profit', category: 'Performance Warning', title: 'Adjusted profit is negative', text: 'Return-adjusted profit is below zero for the selected period.', metric: `Adjusted Profit ${fullNumber(metrics.return_adjusted_net_profit)}`, priority: 'High', target: 'campaigns', cta: 'View Performance' });
  if (radar?.gaps.length) attentionItems.push({ key: 'gaps', category: 'Budget Issue', title: `${radar.gaps.length} campaigns well below blended ROAS`, text: 'Possible budget inefficiency among campaigns with above-median spend.', metric: `Lowest: ${radar.gaps[0].campaign_id} at ${roasText(radar.gaps[0].roas)}`, priority: 'Medium', target: 'optimizer', cta: 'Review Budget' });
  if (pendingDecisions.length) attentionItems.push({ key: 'decisions', category: 'Pending Decision', title: `${pendingDecisions.length} ${pendingDecisions.length === 1 ? 'decision is' : 'decisions are'} waiting for review`, text: 'Investigation candidates have not been approved or rejected yet.', priority: 'Medium', target: 'decisions', cta: 'Review Decisions' });
  if (dataWarning) attentionItems.push({ key: 'data', category: 'Data Warning', title: 'Data quality issue detected', text: 'Some records need review before relying on the numbers.', priority: Number(duplicateRecordCount) > 0 ? 'Medium' : 'Low', target: 'data', cta: 'View Details' });
  if (radar?.unusual.length) attentionItems.push({ key: 'anomaly', category: 'Anomaly', title: `${radar.unusual.length} unusual revenue ${radar.unusual.length === 1 ? 'day' : 'days'}`, text: 'Revenue differed sharply from the daily average. Cause not determined.', priority: 'Low', target: 'insights', cta: 'Review Anomalies' });
  attentionItems.sort((a, b) => priorityRank[a.priority ?? 'Low'] - priorityRank[b.priority ?? 'Low']);

  const decisionItems: ActionItem[] = pendingDecisions.slice(0, 3).map((item) => ({
    key: item.id, category: 'Awaiting Review', title: item.title,
    text: `${item.channel === item.ad_platform ? item.channel : `${item.channel} · ${item.ad_platform}`}. Negative return-adjusted profit across the dataset.`,
    metric: `Adjusted Profit ${fullNumber(item.evidence?.return_adjusted_net_profit)} on ${fullNumber(item.evidence?.ad_spend)} spend`,
    target: 'decisions', cta: 'Review Decision',
  }));

  const opportunityItems: ActionItem[] = (radar?.highRoas || []).slice(0, 3).map((row) => ({
    key: `${row.campaign_id}-${row.sku_id}-${row.ad_platform}`, category: 'Potential Opportunity', title: `${row.campaign_id}`,
    text: `High-efficiency campaign on ${row.channel}. Worth reviewing.`,
    metric: `ROAS ${roasText(row.roas)}${totalSpend ? ` · Spend share ${(Number(row.spend) / totalSpend * 100).toFixed(1)}%` : ''}`,
    target: 'opportunities', cta: 'Explore Opportunity',
  }));
  if (radar?.realloc && opportunityItems.length < 3) opportunityItems.push({ key: 'realloc', category: 'Budget Opportunity', title: `Budget shift from ${radar.realloc.from.channel} to ${radar.realloc.to.channel}`, text: 'Channel ROAS differs noticeably. Worth reviewing.', metric: `ROAS ${roasText(radar.realloc.from.roas)} vs ${roasText(radar.realloc.to.roas)}`, target: 'opportunities', cta: 'Explore Opportunity' });

  const alertItems: { key: string; time: string; type: string; text: string; severity: Priority; target: Section }[] = [];
  (radar?.unusual || []).forEach((day) => alertItems.push({ key: `day-${day.date}`, time: dateOnly(day.date), type: 'Anomaly Detected', text: `Revenue was ${day.z > 0 ? 'above' : 'below'} the daily average (${fullNumber(day.revenue)} vs ${fullNumber(radar?.mean)}).`, severity: Math.abs(day.z) >= 3 ? 'Medium' : 'Low', target: 'insights' }));
  if (roasChange && roasChange.pct <= -10) alertItems.push({ key: 'roas', time: dateOnly(trendDays[trendDays.length - 1]?.date), type: 'Performance Alert', text: `ROAS fell ${Math.abs(roasChange.pct).toFixed(0)}% versus the previous 30 days of data.`, severity: roasDropPriority, target: 'campaigns' });
  if (dataWarning && lastUpdated) alertItems.push({ key: 'data', time: clock(lastUpdated), type: 'Data Warning', text: 'Data quality issue detected.', severity: 'Low', target: 'data' });
  if (!loading && health?.status !== 'ok' && lastUpdated) alertItems.push({ key: 'sync', time: clock(lastUpdated), type: 'Sync Issue', text: 'The data source is not responding.', severity: 'Medium', target: 'data' });
  alertItems.sort((a, b) => priorityRank[a.severity] - priorityRank[b.severity]);

  const activityLabels: Record<string, string> = { approved: 'Decision approved', rejected: 'Decision rejected', simulated: 'Investigation simulated' };
  const activityItems: { key: string; label: string; time: string; detail?: string }[] = [
    ...(lastUpdated ? [{ key: 'refresh', label: 'Dataset refreshed', time: clock(lastUpdated), detail: dataSourceName }] : []),
    ...history.slice(0, 4).map((event, index) => ({ key: `${event.decision_id}-${index}`, label: activityLabels[event.status] || 'Decision updated', time: clock(new Date(event.created_at)), detail: String(event.target || '').replace('|', ' / ') })),
  ];

  const briefItems: ActionItem[] = [];
  if (roasChange) briefItems.push({ key: 'roas', category: 'Performance Change', title: roasChange.pct <= -10 ? 'ROAS declined' : roasChange.pct >= 10 ? 'ROAS improved' : 'ROAS is steady', text: `Compared with the previous 30 days of data (${roasChange.pct >= 0 ? '+' : ''}${roasChange.pct.toFixed(0)}%).`, metric: roasMetric, priority: roasChange.pct <= -10 ? roasDropPriority : undefined, target: 'campaigns', cta: 'View Performance' });
  if (opportunityItems[0]) briefItems.push({ ...opportunityItems[0], key: 'brief-opportunity', category: 'Opportunity', title: `${radar?.highRoas.length ?? 0} high-ROAS ${radar?.highRoas.length === 1 ? 'campaign' : 'campaigns'} to review`, text: `${opportunityItems[0].title} leads on efficiency.`, cta: 'View Opportunity' });
  if (pendingDecisions.length) briefItems.push({ key: 'brief-decision', category: 'Decision Pending', title: `${pendingDecisions.length} ${pendingDecisions.length === 1 ? 'recommendation is' : 'recommendations are'} waiting for review`, text: pendingDecisions[0].title, priority: 'Medium', target: 'decisions', cta: 'Review Decision' });
  if (radar?.realloc) briefItems.push({ key: 'brief-budget', category: 'Budget', title: `ROAS differs across channels`, text: `${radar.realloc.to.channel} is highest and ${radar.realloc.from.channel} is lowest.`, metric: `ROAS ${roasText(radar.realloc.to.roas)} vs ${roasText(radar.realloc.from.roas)}`, target: 'optimizer', cta: 'Review Budget' });
  if (dataWarning) briefItems.push({ key: 'brief-data', category: 'Data Warning', title: 'Data quality issue detected', text: 'Some records need review.', priority: 'Low', target: 'data', cta: 'View Details' });
  const brief = briefItems.slice(0, 5);

  const healthRows: { label: string; value: string; tone: string }[] = [
    { label: 'Data Source', value: loading ? 'Checking' : health?.status === 'ok' ? 'Connected' : 'Offline', tone: loading ? 'neutral' : health?.status === 'ok' ? 'good' : 'warn' },
    { label: 'Last Updated', value: lastUpdated ? clock(lastUpdated) : '—', tone: 'neutral' },
    { label: 'Data Health', value: !qualityChecked ? 'Not checked' : dataWarning ? 'Needs Attention' : 'Healthy', tone: !qualityChecked ? 'neutral' : dataWarning ? 'warn' : 'good' },
    { label: 'Decision Engine', value: decisionsReady ? 'Ready' : 'Limited', tone: decisionsReady ? 'good' : 'warn' },
  ];
  const quickActions: { label: string; target: Section; icon: typeof Gauge }[] = [
    { label: 'Explore Performance', target: 'campaigns', icon: BarChart3 },
    { label: 'Review Anomalies', target: 'insights', icon: TriangleAlert },
    { label: 'View Opportunities', target: 'opportunities', icon: Target },
    { label: 'Open Decision Center', target: 'decisions', icon: Check },
    { label: 'Run Budget Simulation', target: 'optimizer', icon: TrendingUp },
    { label: 'Ask AI Copilot', target: 'copilot', icon: Command },
  ];

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
          <div className="page-heading"><div><h1>Action Center</h1><p>Review what needs attention, what requires a decision, and what action to take next.</p></div></div>
          <div className="ac-grid">
            <section className="panel ac-panel ac-brief"><div className="panel-head"><div><h2>Today’s Brief</h2></div></div>
              {loading ? <div className="state-card"><LoaderCircle className="spin" />Loading updates…</div> : brief.length ? <div className="ac-brief-grid">{brief.map((item) => <ActionCard key={item.key} item={item} onGo={goTo} />)}</div> : <p className="ac-empty">No updates to report right now.</p>}
            </section>
            <section className="panel ac-panel ac-attention"><div className="panel-head"><div><h2>Needs Attention</h2></div>{attentionItems.length > 0 && <span className="mini-tag">{attentionItems.length}</span>}</div>
              {attentionItems.length ? attentionItems.map((item) => <ActionCard key={item.key} item={item} onGo={goTo} />) : <p className="ac-empty">Nothing needs attention right now.</p>}
            </section>
            <section className="panel ac-panel ac-decisions"><div className="panel-head"><div><h2>Pending Decisions</h2></div>{pendingDecisions.length > 0 && <span className="mini-tag">{pendingDecisions.length}</span>}</div>
              {decisionItems.length ? decisionItems.map((item) => <ActionCard key={item.key} item={item} onGo={goTo} />) : <p className="ac-empty">No decisions are waiting for review.</p>}
              {pendingDecisions.length > decisionItems.length && <button type="button" className="ac-more" onClick={() => goTo('decisions')}>View all {pendingDecisions.length} decisions <ArrowRight size={12} /></button>}
            </section>
            <section className="panel ac-panel ac-opportunities"><div className="panel-head"><div><h2>Top Opportunities</h2></div></div>
              {opportunityItems.length ? opportunityItems.map((item) => <ActionCard key={item.key} item={item} onGo={goTo} />) : <p className="ac-empty">No opportunities identified for the current filters.</p>}
            </section>
            <section className="panel ac-panel ac-alerts"><div className="panel-head"><div><h2>Recent Alerts</h2></div></div>
              {alertItems.length ? alertItems.slice(0, 5).map((alert) => <div className="ac-alert" key={alert.key}>
                <div className="ac-item-main"><div className="ac-item-meta"><span>{alert.time}</span><PriorityBadge level={alert.severity} /></div><b>{alert.type}</b><p>{alert.text}</p></div>
                <button type="button" className="ac-link" onClick={() => goTo(alert.target)}>View Details <ArrowRight size={12} /></button>
              </div>) : <p className="ac-empty">No recent alerts.</p>}
            </section>
            <section className="panel ac-panel ac-activity"><div className="panel-head"><div><h2>Recent Activity</h2></div><button type="button" className="ac-link" onClick={() => goTo('execution')}>View Audit <ArrowRight size={12} /></button></div>
              {activityItems.length ? activityItems.map((item) => <div className="ac-activity-row" key={item.key}><span><b>{item.label}</b>{item.detail && <small>{item.detail}</small>}</span><time>{item.time}</time></div>) : <p className="ac-empty">No recent activity.</p>}
            </section>
            <section className="panel ac-panel ac-health"><div className="panel-head"><div><h2>System Health</h2></div></div>
              {healthRows.map((row) => <div className="ac-health-row" key={row.label}><span>{row.label}</span><b className={`ac-tone ${row.tone}`}>{row.value}</b></div>)}
              <button type="button" className="ac-more" onClick={() => goTo('data')}>View Data Details <ArrowRight size={12} /></button>
            </section>
            <section className="panel ac-panel ac-quick"><div className="panel-head"><div><h2>Quick Actions</h2></div></div>
              <div className="ac-quick-grid">{quickActions.map((action) => { const Icon = action.icon; return <button type="button" key={action.label} onClick={() => goTo(action.target)}><Icon size={15} />{action.label}</button>; })}</div>
            </section>
          </div>
          <p className="ac-note">Insights are based on available campaign data. No live advertising changes are made automatically.</p>
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
        {section === 'opportunities' && <>
          <div className="page-heading"><div><h1>Opportunity Radar</h1><p>Campaign opportunities and efficiency gaps found in the filtered data. Candidates are rule-based and for review only.</p></div><div className="explorer-meta"><span>Last updated: {lastUpdated ? lastUpdated.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'}</span></div></div>
          {!radar ? (loading || !campaigns ? <div className="state-card"><LoaderCircle className="spin" />Scanning for opportunities…</div> : <section className="panel"><Empty text="Opportunities appear once campaign data with spend and revenue is available." /></section>) : <>
            <div className="explorer-kpis">
              <div><span>Blended ROAS <Info text={metricHelp.roas} label="About ROAS" /></span><strong>{roasText(radar.blended)}</strong></div>
              <div><span>High-ROAS Pockets</span><strong>{radar.highRoas.length}</strong></div>
              <div><span>Efficiency Gaps</span><strong>{radar.gaps.length}</strong></div>
              <div><span>Unusual Days</span><strong>{radar.unusual.length}</strong></div>
            </div>
            <section className="panel explorer-panel"><div className="panel-head"><div><h2>Budget Reallocation Candidate</h2><p>Channel ROAS comparison for the current filters.</p></div></div>
              {radar.realloc ? <div className="radar-row"><div><b>Review shifting budget from {radar.realloc.from.channel} to {radar.realloc.to.channel}</b><small>{radar.realloc.from.channel} returns {roasText(radar.realloc.from.roas)} on {fullNumber(radar.realloc.from.spend)} spend; {radar.realloc.to.channel} returns {roasText(radar.realloc.to.roas)} on {fullNumber(radar.realloc.to.spend)} spend.</small></div><span className="mini-tag">{roasText(Number(radar.realloc.to.roas) - Number(radar.realloc.from.roas))} gap</span></div> : <Empty text="Channel ROAS values are too similar to suggest a reallocation." />}
              <p className="radar-note">Observed ROAS only. Expected impact is not estimated and no spend is changed.</p>
            </section>
            <div className="radar-grid">
              <section className="panel explorer-panel"><div className="panel-head"><div><h2>High-ROAS Pockets</h2><p>Campaigns at least 20% above blended ROAS with above-median spend.</p></div></div>
                {radar.highRoas.length ? radar.highRoas.map((row) => <div className="radar-row" key={`${row.campaign_id}-${row.sku_id}-${row.ad_platform}`}><div><b>{row.campaign_id}</b><small>{row.channel} · Spend {fullNumber(row.spend)} · Revenue {fullNumber(row.attributed_revenue)}</small></div><strong>{roasText(row.roas)}</strong></div>) : <Empty text="No campaigns currently meet this rule." />}
              </section>
              <section className="panel explorer-panel"><div className="panel-head"><div><h2>Efficiency Gaps</h2><p>Campaigns at least 20% below blended ROAS with above-median spend.</p></div></div>
                {radar.gaps.length ? radar.gaps.map((row) => <div className="radar-row" key={`${row.campaign_id}-${row.sku_id}-${row.ad_platform}`}><div><b>{row.campaign_id}</b><small>{row.channel} · Spend {fullNumber(row.spend)} · Revenue {fullNumber(row.attributed_revenue)}</small></div><strong>{roasText(row.roas)}</strong></div>) : <Empty text="No campaigns currently meet this rule." />}
              </section>
            </div>
            <section className="panel explorer-panel"><div className="panel-head"><div><h2>Unusual Revenue Days</h2><p>Days where revenue is at least two standard deviations from the period average.</p></div></div>
              {radar.unusual.length ? radar.unusual.map((day) => <div className="radar-row" key={day.date}><div><b>{dateOnly(day.date)}</b><small>Revenue {fullNumber(day.revenue)} vs. daily average {fullNumber(radar.mean)}</small></div><span className="mini-tag">{day.z > 0 ? 'Above average' : 'Below average'}</span></div>) : <Empty text="No unusual days in the selected period." />}
              <p className="radar-note">Causes are not inferred. See Anomaly &amp; diagnosis for details.</p>
            </section>
          </>}
        </>}

        {!['overview', 'campaigns', 'opportunities', 'insights', 'data', 'summary', 'decisions', 'execution'].includes(section) && <><div className="page-heading"><div><div className="eyebrow">ADPILOT WORKSPACE</div><h1>{navItems.find((item) => item.id === section)?.label}</h1><p>This screen is reserved for a future workflow; no unsupported analytics are shown.</p></div></div><section className="panel"><Empty text="This local MVP currently provides verified campaign metrics, rule-based investigation candidates, human review history, and AI-generated summaries. It does not generate budget allocations or execute live ad-account changes." /></section></>}
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
