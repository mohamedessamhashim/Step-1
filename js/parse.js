// Reads counts out of text pasted from the qbank dashboard. Pure.
//
// It looks for each known label followed by a number, trying the longest
// labels first and never reusing text that a longer label already claimed.
// That is what keeps "Pharmacology (General Principles) 45" (a system) apart
// from "Pharmacology 495" (a subject), and "Unused 3,255" apart from "Used 399".

const TOTAL_LABELS = {
  all: ['total questions', 'all questions', 'total', 'all'],
  unused: ['unused questions', 'unused'],
  used: ['used questions', 'used'],
  correct: ['total correct', 'correct'],
  incorrect: ['total incorrect', 'incorrect'],
  marked: ['total marked', 'marked'],
  omitted: ['total omitted', 'omitted'],
};

const normalize = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[‘’]/g, "'")
    .replace(/\band\b/g, '&')
    .replace(/[\s ]+/g, ' ')
    .trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export function parseDashboard(text, { systems = [], subjects = [] } = {}) {
  const source = normalize(text);
  const targets = [
    ...systems.map((s) => ({ kind: 'systems', key: s.id, label: normalize(s.name) })),
    ...subjects.map((s) => ({ kind: 'subjects', key: s.name, label: normalize(s.name) })),
    ...Object.entries(TOTAL_LABELS).flatMap(([key, labels]) => labels.map((label) => ({ kind: 'totals', key, label }))),
  ].sort((a, b) => b.label.length - a.label.length);

  const out = { systems: {}, subjects: {}, totals: {} };
  const claimed = [];
  const overlaps = (from, to) => claimed.some(([a, b]) => from < b && to > a);

  for (const t of targets) {
    if (!t.label || t.key in out[t.kind]) continue;
    // label, optional punctuation, then a number such as 418 or 3,255 (but not a percentage)
    const re = new RegExp(`${escapeRe(t.label)}(?![a-z])\\s*[:=\\-–—·|(]*\\s*(\\d{1,3}(?:,\\d{3})+|\\d+)(?![\\d.]*%)`, 'g');
    for (const m of source.matchAll(re)) {
      const from = m.index;
      const to = from + m[0].length;
      // Must start a word: "used" inside "unused" does not count.
      if (from > 0 && /[a-z0-9]/.test(source[from - 1])) continue;
      if (overlaps(from, to)) continue;
      out[t.kind][t.key] = Number(m[1].replace(/,/g, ''));
      claimed.push([from, to]);
      break;
    }
  }

  return {
    ...out,
    found: {
      systems: Object.keys(out.systems).length,
      subjects: Object.keys(out.subjects).length,
      totals: Object.keys(out.totals).length,
    },
    missingSystems: systems.filter((s) => !(s.id in out.systems)).map((s) => s.name),
  };
}
