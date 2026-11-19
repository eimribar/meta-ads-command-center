// Bayesian cost-per-result statistics. Pure math, no I/O.
//
// Model: over a window an ad spends `spend` and gets `results`. Results are Poisson with
// results ~ Poisson(spend * rate), where rate = results per unit of spend = 1 / cost per result.
// The conjugate prior on a Poisson rate is a Gamma, so with a Gamma(alpha0, beta0) prior the
// posterior is closed form:   rate ~ Gamma(alpha0 + results, beta0 + spend)
//
// The prior is centred on a reference cost (normally the target) and is worth `priorResults`
// imagined results: alpha0 = priorResults, beta0 = priorResults * priorCost. A small
// priorResults makes it weak, so real spend quickly outweighs it.
//
// Cost = 1/rate, so a posterior interval on the rate inverts to one on cost; the map is
// decreasing, so the LOW cost bound comes from the HIGH rate quantile and the other way round.
// Gamma quantiles use the Wilson-Hilferty approximation (no libraries); the probability of
// beating a bar uses the exact regularized incomplete gamma.
import { money } from '../money.mjs';

// standard normal inverse CDF (Acklam)
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const plow = 0.02425, phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= phigh) {
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// p-quantile of Gamma(shape k, rate b), Wilson-Hilferty
function gammaQuantile(p, k, b) {
  if (k <= 0 || b <= 0 || p <= 0) return 0;
  if (p >= 1) return Infinity;
  const z = normInv(p);
  const t = Math.max(1 - 1 / (9 * k) + z * Math.sqrt(1 / (9 * k)), 0);
  return (k * t * t * t) / b;
}

// ln Gamma (Lanczos)
function lnGamma(z) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = c[0];
  for (let i = 1; i < 9; i++) x += c[i] / (z + i);
  const t = z + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// lower regularized incomplete gamma P(k, x): series below k+1, continued fraction above
function lowerGammaP(k, x) {
  if (x <= 0) return 0;
  if (k <= 0) return 1;
  if (x < k + 1) {
    let term = 1 / k, sum = term;
    for (let n = 1; n < 500; n++) {
      term *= x / (k + n); sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
    }
    return sum * Math.exp(-x + k * Math.log(x) - lnGamma(k));
  }
  let b = x + 1 - k, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - k);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-12) break;
  }
  return 1 - Math.exp(-x + k * Math.log(x) - lnGamma(k)) * h;
}

const round = (v, n = 2) => (v == null || !Number.isFinite(v) ? v : Math.round(v * 10 ** n) / 10 ** n);
const clean = (v) => Math.max(0, Number(v) || 0);

function prior({ priorCost, priorResults }, fallbackCost) {
  const cost = Number(priorCost) > 0 ? Number(priorCost) : fallbackCost;
  // 0 is a valid setting (no prior weight); a Gamma needs a positive shape, so it becomes tiny.
  const n = priorResults == null || priorResults === '' ? NaN : Number(priorResults);
  const pr = Number.isFinite(n) && n >= 0 ? Math.max(n, 0.01) : 3;
  return { alpha0: pr, beta0: pr * cost };
}

// Posterior cost per result: { meanCost, lo90, hi90, meanRate, alpha, beta }. Never throws.
export function costPosterior(stat = {}) {
  const s = stat || {};
  const spend = clean(s.spend), results = clean(s.results);
  const { alpha0, beta0 } = prior(s, 1);
  const alpha = alpha0 + results;
  const beta = beta0 + spend;
  const rateHi = gammaQuantile(0.95, alpha, beta);
  const rateLo = gammaQuantile(0.05, alpha, beta);
  return {
    meanCost: round(beta / alpha),
    lo90: round(rateHi > 0 ? 1 / rateHi : null),
    hi90: round(rateLo > 0 ? 1 / rateLo : null),
    meanRate: round(alpha / beta, 6),
    alpha: round(alpha, 4),
    beta: round(beta, 4),
  };
}

// P(true cost per result <= bar). With no prior cost given, the prior is centred on the bar.
export function probBeatsBar(stat = {}, bar) {
  const b = Number(bar);
  if (!Number.isFinite(b) || b <= 0) return 0;
  const s = stat || {};
  const { alpha0, beta0 } = prior(s, b);
  const alpha = alpha0 + clean(s.results);
  const beta = beta0 + clean(s.spend);
  return Math.min(1, Math.max(0, 1 - lowerGammaP(alpha, beta / b)));
}

// Proven = P(cost <= bar) >= minProb over at least minDays of mature data.
export function isProvenWinner(stat = {}, { bar, matureDays = 0, minDays = 4, minProb = 0.9 } = {}) {
  const prob = round(probBeatsBar(stat, bar), 4);
  const enoughDays = (Number(matureDays) || 0) >= minDays;
  const enoughProb = prob >= minProb;
  const pct = (prob * 100).toFixed(1);
  const reason = enoughDays && enoughProb ? `proven: ${pct}% likely under ${money(bar)} over ${matureDays} mature days`
    : !enoughDays && !enoughProb ? `unproven: ${matureDays} of ${minDays} mature days, ${pct}% likely under ${money(bar)}`
      : !enoughDays ? `not yet: ${pct}% likely under ${money(bar)} but only ${matureDays} of ${minDays} mature days`
        : `not yet: ${pct}% likely under ${money(bar)}, needs ${minProb * 100}%`;
  return { proven: enoughDays && enoughProb, prob, reason };
}

// Meta keeps attributing results for about two days, so only days at least `lagDays` old count.
export function matureRows(rows, { asOf, lagDays = 2 } = {}) {
  if (!Array.isArray(rows) || !rows.length) return [];
  const d = new Date(`${asOf || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (Number(lagDays) || 0));
  const cutoff = d.toISOString().slice(0, 10);
  return rows.filter((r) => r && typeof r.date === 'string' && r.date <= cutoff);
}
