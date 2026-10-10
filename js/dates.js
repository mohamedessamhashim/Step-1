// Calendar days are 'YYYY-MM-DD' strings, so they sort and compare as text.
// All arithmetic goes through UTC, which keeps it correct across clock changes.

const DAY_MS = 86400000;

export const toUTC = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const fromUTC = (t) => new Date(t).toISOString().slice(0, 10);

export const addDays = (s, n) => fromUTC(toUTC(s) + n * DAY_MS);
/** Whole days from a to b (positive when b is later). */
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
/** 0 = Sunday … 6 = Saturday. */
export const dow = (s) => new Date(toUTC(s)).getUTCDay();
export const isWeekend = (s) => dow(s) === 0 || dow(s) === 6;

export function range(a, b) {
  const out = [];
  for (let d = a; d <= b; d = addDays(d, 1)) out.push(d);
  return out;
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fromUTC(toUTC(s)) === s;

/** Today in the device's own time zone. */
export function todayLocal(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export const monthKey = (s) => s.slice(0, 7);
export const monthStart = (s) => `${s.slice(0, 7)}-01`;
export function addMonths(s, n) {
  const y = +s.slice(0, 4);
  const m = +s.slice(5, 7) - 1 + n;
  return fromUTC(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
}
export const daysInMonth = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0)).getUTCDate();

const STYLES = {
  weekday: { weekday: 'long' },
  monthDay: { month: 'long', day: 'numeric' },
  short: { weekday: 'short', month: 'short', day: 'numeric' },
  md: { month: 'short', day: 'numeric' },
  long: { weekday: 'long', month: 'long', day: 'numeric' },
  full: { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' },
  monthYear: { month: 'long', year: 'numeric' },
  month: { month: 'short' },
};
const formatters = {};

export function fmt(s, style = 'short') {
  formatters[style] ??= new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...STYLES[style] });
  return formatters[style].format(new Date(toUTC(s))).replace(/,(?= \w{3} \d)/, '');
}
