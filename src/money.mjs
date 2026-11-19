// Money in the ad account's own currency. The currency code is read from the ad account (see
// account.mjs, loadAccountBasics) and every amount the agent writes goes through money().
//
// Meta sends and takes budgets in the minimum denomination of the ad account's currency (cents
// for USD): daily_budget 5000 is 50.00 in most currencies. For the currencies Meta lists with an
// offset of 1, the number is the amount itself.

let code = null;
const formatters = new Map();

// Currencies Meta lists with an offset of 1; every other currency is 100.
// developers.facebook.com/documentation/ads-commerce/marketing-api/currencies (read 2026-11-18)
export const OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);

export function setCurrency(c) {
  code = c ? String(c).trim().toUpperCase() : null;
  formatters.clear();
}
export const currency = () => code;
export const offset = (c = code) => (c && OFFSET_ONE.has(c) ? 1 : 100);

// Meta's minor units to an amount, and back.
export function fromMinor(v, c = code) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return null;
  return Math.round(Number(v)) / offset(c);
}
export function toMinor(amount, c = code) {
  return String(Math.round(Number(amount) * offset(c)));
}

function formatter(decimals) {
  const k = `${code}:${decimals}`;
  if (!formatters.has(k)) {
    let f;
    try { f = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
    catch { f = null; }
    formatters.set(k, f);
  }
  return formatters.get(k);
}
const digitsOf = (c) => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).resolvedOptions().maximumFractionDigits; }
  catch { return 2; }
};

// An amount for people: "$1,250", "€12.50", "£480". Whole amounts drop the decimals. With no
// currency known yet it is a plain number.
export function money(v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return 'n/a';
  const n = Number(v);
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  if (!code) return n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 });
  const f = formatter(whole ? 0 : digitsOf(code));
  return f ? f.format(n) : `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${code}`;
}

// A number typed by a person ("1,250", "$1250", "£ 480", "12.50") as an amount. Null when it is
// not one. A comma only separates thousands (1,250 or 1,250,000.50): "12,5" is refused rather
// than read as 125, because in many countries it means 12.5.
// "1.250" (one dot, exactly three digits after it, nothing else) reads as 1.25 in some countries
// and 1250 in others, so it is refused rather than guessed. Returns the message, or null.
export function ambiguousAmount(v) {
  if (v == null || typeof v === 'number') return null;
  const s = String(v).replace(/[\p{Sc}\s]/gu, '');
  if (!/^\d{1,3}\.\d{3}$/.test(s)) return null;
  return `"${String(v).trim()}" can be read two ways: write ${s.replace('.', '')} for the thousands (no dot), or ${Number(s)} for the decimal`;
}

export function parseAmountText(v) {
  if (v == null) return null;
  if (ambiguousAmount(v)) return null;
  const s = String(v).replace(/[\p{Sc}\s]/gu, '');
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/.test(s)) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
export const parseAmount = parseAmountText;
