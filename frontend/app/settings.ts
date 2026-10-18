export type Theme = 'light' | 'dark' | 'system';
export type MetricKey = 'revenue' | 'spend' | 'profit' | 'roas';
export type Objective = 'revenue' | 'profit';

export type Settings = {
  workspaceName: string;
  currency: string;
  timezone: string;
  landing: string;
  theme: Theme;
  sidebar: 'expanded' | 'collapsed';
  density: 'comfortable' | 'compact';
  period: number;
  channel: string;
  metric: MetricKey;
  alerts: { performance: boolean; anomaly: boolean; decision: boolean };
  confirmApply: boolean;
  confirmRollback: boolean;
  maxBudgetChange: number;
  objective: Objective;
  show: { brief: boolean; attention: boolean; decisions: boolean; opportunities: boolean; alerts: boolean };
};

export const DEFAULT_SETTINGS: Settings = {
  workspaceName: 'Lumière Skin Co.',
  currency: 'none',
  timezone: 'browser',
  landing: 'overview',
  theme: 'dark',
  sidebar: 'expanded',
  density: 'comfortable',
  period: 0,
  channel: '',
  metric: 'revenue',
  alerts: { performance: true, anomaly: true, decision: true },
  confirmApply: true,
  confirmRollback: true,
  maxBudgetChange: 20,
  objective: 'profit',
  show: { brief: true, attention: true, decisions: true, opportunities: true, alerts: true },
};

export const CURRENCIES = [
  { id: 'none', label: 'None (plain numbers)', symbol: '' },
  { id: 'INR', label: 'Indian Rupee (₹)', symbol: '₹' },
  { id: 'USD', label: 'US Dollar ($)', symbol: '$' },
  { id: 'EUR', label: 'Euro (€)', symbol: '€' },
  { id: 'GBP', label: 'British Pound (£)', symbol: '£' },
];

export const TIMEZONES = [
  { id: 'browser', label: 'Browser default' },
  { id: 'UTC', label: 'UTC' },
  { id: 'Asia/Kolkata', label: 'India (Asia/Kolkata)' },
  { id: 'Asia/Dubai', label: 'Dubai (Asia/Dubai)' },
  { id: 'Asia/Singapore', label: 'Singapore (Asia/Singapore)' },
  { id: 'Europe/London', label: 'London (Europe/London)' },
  { id: 'Europe/Paris', label: 'Central Europe (Europe/Paris)' },
  { id: 'America/New_York', label: 'US Eastern (America/New_York)' },
  { id: 'America/Chicago', label: 'US Central (America/Chicago)' },
  { id: 'America/Los_Angeles', label: 'US Pacific (America/Los_Angeles)' },
  { id: 'Australia/Sydney', label: 'Sydney (Australia/Sydney)' },
];

export const PERIODS = [
  { value: 0, label: 'All time' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
  { value: 365, label: 'Last 12 months' },
];

export const LANDING_PAGES = [
  { id: 'overview', label: 'Action Center' },
  { id: 'campaigns', label: 'Performance Explorer' },
  { id: 'insights', label: 'Anomaly & Diagnosis' },
  { id: 'opportunities', label: 'Opportunity Radar' },
  { id: 'decisions', label: 'Decision Center' },
  { id: 'optimizer', label: 'Budget Optimizer' },
  { id: 'data', label: 'Unified Data Hub' },
  { id: 'execution', label: 'Execution & Audit' },
  { id: 'summary', label: 'AI Data Summary' },
];

export const METRICS: { id: MetricKey; label: string }[] = [
  { id: 'revenue', label: 'Revenue' },
  { id: 'spend', label: 'Spend' },
  { id: 'profit', label: 'Profit' },
  { id: 'roas', label: 'ROAS' },
];

const STORAGE_KEY = 'adpilot.settings.v1';
const bool = (value: unknown, fallback: boolean) => (typeof value === 'boolean' ? value : fallback);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}

// Merge whatever is stored with the defaults, keeping only valid values.
export function sanitizeSettings(raw: unknown): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const name = typeof r.workspaceName === 'string' ? r.workspaceName.trim().slice(0, 40) : '';
  const max = Number(r.maxBudgetChange);
  return {
    workspaceName: name || d.workspaceName,
    currency: CURRENCIES.some((item) => item.id === r.currency) ? r.currency : d.currency,
    timezone: r.timezone === 'browser' || (validZone(r.timezone) && TIMEZONES.some((item) => item.id === r.timezone)) ? r.timezone : d.timezone,
    landing: LANDING_PAGES.some((item) => item.id === r.landing) ? r.landing : d.landing,
    theme: oneOf(r.theme, ['light', 'dark', 'system'] as const, d.theme),
    sidebar: oneOf(r.sidebar, ['expanded', 'collapsed'] as const, d.sidebar),
    density: oneOf(r.density, ['comfortable', 'compact'] as const, d.density),
    period: PERIODS.some((item) => item.value === r.period) ? r.period : d.period,
    channel: typeof r.channel === 'string' ? r.channel.slice(0, 100) : d.channel,
    metric: oneOf(r.metric, ['revenue', 'spend', 'profit', 'roas'] as const, d.metric),
    alerts: {
      performance: bool(r.alerts?.performance, d.alerts.performance),
      anomaly: bool(r.alerts?.anomaly, d.alerts.anomaly),
      decision: bool(r.alerts?.decision, d.alerts.decision),
    },
    confirmApply: bool(r.confirmApply, d.confirmApply),
    confirmRollback: bool(r.confirmRollback, d.confirmRollback),
    maxBudgetChange: Number.isFinite(max) && max >= 0 && max <= 100 ? max : d.maxBudgetChange,
    objective: oneOf(r.objective, ['revenue', 'profit'] as const, d.objective),
    show: {
      brief: bool(r.show?.brief, d.show.brief),
      attention: bool(r.show?.attention, d.show.attention),
      decisions: bool(r.show?.decisions, d.show.decisions),
      opportunities: bool(r.show?.opportunities, d.show.opportunities),
      alerts: bool(r.show?.alerts, d.show.alerts),
    },
  };
}

export function loadSettings(): Settings {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(stored ? JSON.parse(stored) : null);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function persistSettings(settings: Settings): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

// Display formatting shared by every page; updated from the active settings on each render.
const format = { symbol: '', timeZone: undefined as string | undefined };

export function applyFormat(settings: Settings) {
  format.symbol = CURRENCIES.find((item) => item.id === settings.currency)?.symbol ?? '';
  format.timeZone = settings.timezone === 'browser' ? undefined : settings.timezone;
}

export function withCurrency(text: string) {
  if (!format.symbol || text === '—' || text === 'Unavailable') return text;
  return text.startsWith('-') ? `-${format.symbol}${text.slice(1)}` : `${format.symbol}${text}`;
}

export function formatDateTime(value: Date | string | number | null | undefined, withYear = false) {
  if (value == null) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}),
    hour: 'numeric', minute: '2-digit', timeZone: format.timeZone,
  });
}
