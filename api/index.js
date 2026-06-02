'use strict';

const axios = require('axios');
const fcaLists = require('./data/fca-lists.json');
const fcaHolidays = require('./data/fca-holidays.json');

const EXODUS_BASE = 'https://exodus.stockbit.com';

// ── Loaded from DB-generated JSON ──
const ALL_ACTIVE_FCA = new Set(fcaLists.allActiveFca);
const PURE_CRITERIA_1 = new Set(fcaLists.pureCriteria1);
const FCA_CRITERIA = fcaLists.fcaCriteria;
const SUSPENDED_CRITERIA = new Set(fcaLists.suspendedCriteria);
const STOCK_NAMES = fcaLists.stockNames;
const ALUMNI = fcaLists.alumni || [];
const PERIOD_START = fcaLists.periodStart;
const PERIOD_END = fcaLists.periodEnd;
const FCA_THRESHOLD = fcaLists.fcaThreshold;
const IDX_HOLIDAYS = fcaHolidays.holidays;
const holidaySet = new Set(IDX_HOLIDAYS);

function toDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isTradingDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return false;
  return !holidaySet.has(dateStr);
}

function* eachDay(startStr, endStr) {
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  const current = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  while (current <= end) {
    yield toDateStr(current);
    current.setDate(current.getDate() + 1);
  }
}

function formatNumber(n) {
  return Number(n).toLocaleString('id-ID');
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// ── Stockbit API ──
async function sbRequest(path) {
  const token = process.env.STOCKBIT_TOKEN;
  if (!token) throw new Error('STOCKBIT_TOKEN not configured');
  const r = await axios({
    url: `${EXODUS_BASE}${path}`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'FCA-Dashboard/1.0'
    },
    timeout: 30000,
  });
  return r.data;
}

// ── Yahoo Finance ──
async function fetchFromYahoo(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.JK?range=6mo&interval=1d`;
  const r = await axios({ url, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 15000 });
  const result = r.data.chart.result[0];
  const timestamps = result.timestamp;
  const closes = result.indicators.quote[0].close;
  const meta = result.meta;

  const priceMap = new Map();
  for (let i = 0; i < timestamps.length; i++) {
    const d = new Date(timestamps[i] * 1000);
    const dateStr = toDateStr(d);
    if (closes[i] !== null && closes[i] > 0) {
      priceMap.set(dateStr, { close: closes[i], open: result.indicators.quote[0].open?.[i] || closes[i] });
    }
  }

  return {
    ticker,
    companyName: STOCK_NAMES[ticker] || meta.shortName || ticker,
    currentPrice: meta.regularMarketPrice,
    priceMap,
  };
}

// ── Yahoo Finance quick quote (single stock, minimal data) ──
async function fetchYahooQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.JK?range=1d&interval=1d`;
  const r = await axios({ url, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 });
  const meta = r.data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  return {
    price: meta.regularMarketPrice || 0,
    name: STOCK_NAMES[ticker] || meta.shortName || meta.longName || ticker,
    change: meta.regularMarketChange || 0,
    changePct: meta.regularMarketChangePercent || 0,
  };
}

// ── Yahoo Finance batch quotes (parallel with concurrency limit) ──
async function fetchYahooQuotes(tickers) {
  const map = {};
  const BATCH = 6;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(t => fetchYahooQuote(t)));
    for (let j = 0; j < batch.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled' && r.value) {
        map[batch[j]] = r.value;
      }
    }
  }
  return map;
}

// ── Evaluation Engine ──
function evaluate(data) {
  const { priceMap, currentPrice, companyName } = data;

  let totalTradingDays = 0;
  for (const ds of eachDay(PERIOD_START, PERIOD_END)) {
    if (isTradingDay(ds)) totalTradingDays++;
  }

  const now = new Date();
  const wibNow = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
  const todayStr = toDateStr(wibNow);

  let lastDataDate = '';
  for (const ds of eachDay(PERIOD_START, todayStr)) {
    if (priceMap.has(ds)) lastDataDate = ds;
  }

  const months = {};
  let cumulativeClose = 0;
  let elapsedTradingDays = 0;
  let missingDays = [];
  let dailyLog = [];

  for (const ds of eachDay(PERIOD_START, lastDataDate)) {
    if (!isTradingDay(ds)) continue;
    const priceObj = priceMap.get(ds);
    if (priceObj) {
      const closeVal = priceObj.close;
      cumulativeClose += closeVal;
      elapsedTradingDays++;
      const monthKey = ds.slice(0, 7);
      if (!months[monthKey]) months[monthKey] = { days: 0, points: 0 };
      months[monthKey].days++;
      months[monthKey].points += closeVal;
      dailyLog.push({ date: ds, close: closeVal, open: priceObj.open });
    } else {
      missingDays.push(ds);
    }
  }

  let remainingTradingDays = 0;
  let remainingDates = [];
  const nextDay = new Date(new Date(lastDataDate).getTime() + 86400000);
  for (const ds of eachDay(toDateStr(nextDay), PERIOD_END)) {
    if (isTradingDay(ds)) {
      remainingTradingDays++;
      remainingDates.push(ds);
    }
  }

  const targetTotal = FCA_THRESHOLD * totalTradingDays;
  const remainingNeeded = Math.max(0, targetTotal - cumulativeClose);
  const priceNeededPerDay = remainingTradingDays > 0 ? remainingNeeded / remainingTradingDays : 0;

  const recentPrices = dailyLog.slice(-10).map(d => d.close);
  const recentAvg = recentPrices.length > 0
    ? recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length
    : 0;

  // Detect early phase
  const isEarlyPhase = elapsedTradingDays < 10;

  const scenarios = isEarlyPhase ? [] : generateScenarios(
    cumulativeClose, targetTotal, remainingNeeded, remainingTradingDays,
    currentPrice, recentPrices, recentAvg, elapsedTradingDays
  );

  const weeks = {};
  for (const d of dailyLog) {
    const date = new Date(d.date);
    const isoWeek = getISOWeek(date);
    const wk = `${date.getFullYear()}-W${String(isoWeek).padStart(2, '0')}`;
    if (!weeks[wk]) weeks[wk] = { closes: [] };
    weeks[wk].closes.push(d.close);
  }

  const sortedWeeks = Object.entries(weeks).sort((a, b) => a[0].localeCompare(b[0])).slice(-5);
  const weeklyBars = sortedWeeks.map(([wk, data]) => {
    const avg = data.closes.reduce((a, b) => a + b, 0) / data.closes.length;
    const parts = wk.split('-W');
    return { label: `W${parts[1]}`, value: Math.round(avg) };
  });

  const monthNames = { '2026-05': 'May', '2026-06': 'Jun', '2026-07': 'Jul', '2026-08': 'Aug' };
  const monthRows = Object.entries(months).sort().map(([mk, md]) => {
    const mt = md.days * FCA_THRESHOLD;
    const mdlt = md.points - mt;
    return { label: monthNames[mk] || mk, days: md.days, points: md.points, target: mt, delta: mdlt, deltaStr: mdlt >= 0 ? `+${mdlt}` : `${mdlt}` };
  });

  const elapsedTarget = elapsedTradingDays * FCA_THRESHOLD;
  const totalDelta = cumulativeClose - elapsedTarget;
  const totalDeltaStr = totalDelta >= 0 ? `+${totalDelta}` : `${totalDelta}`;

  const verdict = isEarlyPhase ? null : generateVerdict(priceNeededPerDay, currentPrice, dailyLog, lastDataDate, months, monthNames, remainingTradingDays);

  return {
    ticker: data.ticker,
    companyName,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    totalTradingDays,
    elapsedTradingDays,
    remainingTradingDays,
    remainingDates,
    cumulativeClose: Math.round(cumulativeClose),
    targetTotal,
    remainingNeeded: Math.round(remainingNeeded),
    shortfall: Math.max(0, targetTotal - Math.round(cumulativeClose)),
    priceNeededPerDay: Math.round(priceNeededPerDay * 10) / 10,
    currentPrice,
    progressPct: targetTotal > 0 ? ((cumulativeClose / targetTotal) * 100).toFixed(1) : '0',
    elapsedTarget: Math.round(elapsedTarget),
    totalDelta: Math.round(totalDelta),
    totalDeltaStr,
    lastDataDate,
    monthRows,
    weeklyBars,
    scenarios,
    verdict,
    isEarlyPhase,
    contextLines: verdict ? verdict.contextLines : [],
    dailyLog: dailyLog,
  };
}

function generateScenarios(cumulative, target, remainingNeeded, sessionsLeft, currentPrice, recentPrices, recentAvg, elapsedDays) {
  const scenarios = [];
  const validPrices = recentPrices.filter(p => p > 0);
  const periodHigh = Math.max(...validPrices);
  const periodLow = Math.min(...validPrices);

  const dataDepth = elapsedDays < 20 ? 'Rough projection' : elapsedDays < 40 ? 'Moderate confidence' : 'Grounded estimate';

  // 1. Status quo — all sessions at current price
  const sqPoints = currentPrice * sessionsLeft;
  const sqTotal = cumulative + sqPoints;
  scenarios.push({
    label: 'Status quo',
    description: `All ${sessionsLeft} sessions at current Rp${currentPrice}`,
    avgPrice: currentPrice,
    totalPoints: Math.round(sqTotal),
    deficit: Math.round(target - sqTotal),
    passes: sqTotal >= target,
    result: sqTotal >= target ? '✅ Graduate' : '❌ Short by ' + formatNumber(target - sqTotal),
    confidence: dataDepth
  });

  // 2. Recent best — repeat period high (only if it was actually reached)
  const peakPoints = periodHigh * sessionsLeft;
  const peakTotal = cumulative + peakPoints;
  scenarios.push({
    label: 'Period high repeat',
    description: `All ${sessionsLeft} sessions at period high Rp${periodHigh} (actually reached)`,
    avgPrice: periodHigh,
    totalPoints: Math.round(peakTotal),
    deficit: Math.round(target - peakTotal),
    passes: peakTotal >= target,
    result: peakTotal >= target ? '✅ Graduate' : '❌ Short by ' + formatNumber(target - peakTotal),
    confidence: dataDepth
  });

  // 3. Modest uptick — half sessions at +15% above current, half at current
  const uptickPrice = Math.round(currentPrice * 1.15);
  const uptickHalf = Math.ceil(sessionsLeft / 2);
  const baseHalf = sessionsLeft - uptickHalf;
  const uptickPoints = (uptickPrice * uptickHalf) + (currentPrice * baseHalf);
  const uptickTotal = cumulative + uptickPoints;
  const uptickAvg = Math.round(uptickPoints / sessionsLeft);
  const uptickFeasible = uptickPrice <= periodHigh * 1.2;
  if (uptickFeasible) {
    scenarios.push({
      label: 'Modest uptick',
      description: `${uptickHalf} days at Rp${uptickPrice} (+15%), ${baseHalf} at Rp${currentPrice}`,
      avgPrice: uptickAvg,
      totalPoints: Math.round(uptickTotal),
      deficit: Math.round(target - uptickTotal),
      passes: uptickTotal >= target,
      result: uptickTotal >= target ? '✅ Graduate' : '❌ Short by ' + formatNumber(target - uptickTotal),
      confidence: dataDepth
    });
  }

  // 4. Max ARA rally — capped at 7 consecutive days, flat afterwards
  const RALLY_CAP = 7;
  const rallyDays = Math.min(sessionsLeft, RALLY_CAP);
  const flatDays = Math.max(0, sessionsLeft - RALLY_CAP);
  let rallyPrice = currentPrice;
  let rallyPoints = 0;
  for (let i = 0; i < rallyDays; i++) {
    rallyPrice = Math.round(rallyPrice * 1.10);
    rallyPoints += rallyPrice;
  }
  // Flat at peak price for remaining days
  if (flatDays > 0) {
    rallyPoints += rallyPrice * flatDays;
  }
  const rallyTotal = cumulative + rallyPoints;
  const rallyAvg = Math.round(rallyPoints / sessionsLeft);
  scenarios.push({
    label: 'Max ARA rally (capped 7d)',
    description: `${rallyDays}d compounding +10% ARA from Rp${currentPrice}${flatDays > 0 ? `, then flat Rp${rallyPrice} for ${flatDays}d` : ''}`,
    avgPrice: rallyAvg,
    totalPoints: Math.round(rallyTotal),
    deficit: Math.round(target - rallyTotal),
    passes: rallyTotal >= target,
    result: rallyTotal >= target ? '✅ Graduate' : '❌ Short by ' + formatNumber(target - rallyTotal),
    confidence: dataDepth
  });

  return scenarios;
}

function generateVerdict(priceNeededPerDay, currentPrice, dailyLog, lastDataDate, months, monthNames, remainingTradingDays) {
  const last10 = dailyLog.slice(-10);
  if (last10.length < 5) {
    return {
      headline: 'INSUFFICIENT DATA — Not enough trading history to evaluate.',
      label: 'warn', icon: '🟡',
      contextLines: ['Not enough trading data yet.'],
    };
  }

  const first5avg = last10.slice(0, 5).reduce((a, b) => a + b.close, 0) / 5;
  const last5avg = last10.slice(-5).reduce((a, b) => a + b.close, 0) / 5;
  const trendDir = last5avg > first5avg ? 'Up' : last5avg < first5avg ? 'Down' : 'Sideways';

  const allCloses = dailyLog.map(d => d.close);
  const periodHigh = Math.max(...allCloses);
  const periodHighDate = dailyLog.find(d => d.close === periodHigh)?.date || '';

  const monthEntries = Object.entries(months).sort();
  let worstMonth = '', worstDelta = 0;
  for (const [mk, md] of monthEntries) {
    const mTarget = md.days * FCA_THRESHOLD;
    const mDelta = md.points - mTarget;
    if (mDelta < worstDelta) { worstDelta = mDelta; worstMonth = mk; }
  }

  const contextLines = [];

  // Trend line
  contextLines.push(`Trend: ${trendDir} (5d avg ${last5avg.toFixed(1)} vs prior ${first5avg.toFixed(1)})`);

  // Period high line
  if (periodHigh >= priceNeededPerDay) {
    contextLines.push(`Period high: Rp${periodHigh} on ${periodHighDate} — last time above needed level`);
  } else {
    contextLines.push(`Period high: Rp${periodHigh} on ${periodHighDate} — never touched needed Rp${Math.round(priceNeededPerDay)}`);
  }

  // Worst month line
  if (worstMonth) {
    contextLines.push(`Worst month: ${monthNames[worstMonth] || worstMonth} (${worstDelta} pts below target)`);
  }

  // Narrative headline
  let headline, label, icon;
  if (priceNeededPerDay <= 0) {
    headline = 'GRADUATED — Cumulative already exceeds target.';
    label = 'pass'; icon = '✅';
  } else if (priceNeededPerDay <= currentPrice) {
    headline = 'ON TRACK — Below current price, maintain the pace.';
    label = 'pass'; icon = '🟢';
  } else if (priceNeededPerDay <= currentPrice * 1.1) {
    headline = 'TIGHT — Doable with consistency, currently trading at the edge.';
    label = 'warn'; icon = '🟡';
  } else if (priceNeededPerDay <= currentPrice * 1.3) {
    headline = 'UNLIKELY — Requires sustained rally beyond recent range.';
    label = 'fail'; icon = '🟠';
  } else {
    headline = 'IMPOSSIBLE — Needs price levels far above recent trading range.';
    label = 'fail'; icon = '🔴';
  }

  return { headline, label, icon, contextLines };
}

// ── Data Fetching ──
async function fetchClosingPrices(ticker) {
  const data = await sbRequest(`/company-price-feed/prices/close?interval=1&symbol=${ticker}`);
  const items = data?.data ?? [];
  if (!items.length || !items[0].prices) return [];
  return items[0].prices.map(p => parseFloat(p));
}

async function fetchStockDetail(ticker) {
  const data = await sbRequest(`/company-price-feed/v2/orderbook/companies/${ticker}?keyStats=true`);
  const d = data?.data ?? {};
  return {
    ticker: d.symbol || ticker,
    name: d.name || '',
    price: parseFloat(d.lastprice ?? 0),
  };
}

async function evaluateTicker(ticker) {
  const t = ticker.toUpperCase();
  let priceMap, currentPrice, companyName = t;

  try {
    const [sbPrices, detail] = await Promise.all([fetchClosingPrices(t), fetchStockDetail(t)]);
    if (sbPrices.length) {
      priceMap = new Map();
      const now = new Date();
      const wibNow = new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
      const todayStr = toDateStr(wibNow);
      let cur = new Date(todayStr);
      let idx = sbPrices.length - 1;
      while (idx >= 0) {
        const ds = toDateStr(cur);
        if (isTradingDay(ds)) {
          priceMap.set(ds, { close: sbPrices[idx], open: sbPrices[idx] });
          idx--;
        }
        cur.setDate(cur.getDate() - 1);
      }
      currentPrice = detail.price || sbPrices[sbPrices.length - 1];
      companyName = detail.name || t;
    }
  } catch (sbErr) {
    console.error(`[evaluate] Stockbit failed for ${t}: ${sbErr.message}. Falling back to Yahoo...`);
  }

  if (!priceMap || priceMap.size === 0) {
    try {
      const yhData = await fetchFromYahoo(t);
      if (yhData.priceMap && yhData.priceMap.size > 0) {
        priceMap = yhData.priceMap;
        currentPrice = yhData.currentPrice;
        companyName = yhData.companyName;
      }
    } catch (yhErr) {
      console.error(`[evaluate] Yahoo fallback also failed for ${t}: ${yhErr.message}`);
    }
  }

  if (!priceMap || priceMap.size === 0) {
    throw new Error(`No closing price data for ${t} from any source`);
  }

  return evaluate({ priceMap, currentPrice, companyName, ticker: t });
}

// ── FCA 1 List: lightweight evaluation using Yahoo batch quotes ──
async function getFcaList() {
  const pureStocks = [...PURE_CRITERIA_1];
  if (pureStocks.length === 0) return [];

  let quotes = {};
  try {
    quotes = await fetchYahooQuotes(pureStocks);
  } catch (err) {
    console.error('[fca-list] Yahoo quotes failed:', err.message);
    return pureStocks.map(code => ({
      ticker: code,
      name: STOCK_NAMES[code] || code,
      price: 0,
      change: 0,
      changePct: 0,
    }));
  }

  return pureStocks.map(code => {
    const quote = quotes[code];
    return {
      ticker: code,
      name: quote?.name || STOCK_NAMES[code] || code,
      price: quote?.price || 0,
      change: quote?.change || 0,
      changePct: quote?.changePct || 0,
    };
  });
}

// ── Top Picks: lightweight evaluation using Yahoo batch quotes ──
async function getTopPicks() {
  const pureStocks = [...PURE_CRITERIA_1];
  if (pureStocks.length === 0) return [];

  let quotes = {};
  try {
    quotes = await fetchYahooQuotes(pureStocks);
  } catch (err) {
    console.error('[top-picks] Yahoo quotes failed:', err.message);
    return pureStocks.map(code => ({
      ticker: code,
      name: STOCK_NAMES[code] || code,
      price: 0,
      status: 'unknown',
      label: 'warn',
    }));
  }

  const results = [];
  for (const code of pureStocks) {
    const quote = quotes[code];
    if (!quote || !quote.price) {
      results.push({
        ticker: code,
        name: STOCK_NAMES[code] || code,
        price: 0,
        status: 'no data',
        label: 'warn',
      });
      continue;
    }

    results.push({
      ticker: code,
      name: quote.name || STOCK_NAMES[code] || code,
      price: quote.price,
      change: quote.change,
      changePct: quote.changePct,
    });
  }

  results.sort((a, b) => b.price - a.price);
  return results.slice(0, 8);
}

// ── Vercel Serverless Handler ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Route: /api/fca-list
  if (req.url.includes('/api/fca-list')) {
    try {
      const list = await getFcaList();
      return res.status(200).json({
        success: true,
        data: list,
        count: list.length,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      });
    } catch (err) {
      console.error('[fca-list]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Route: /api/alumni
  if (req.url.includes('/api/alumni')) {
    return res.status(200).json({
      success: true,
      data: ALUMNI,
      count: ALUMNI.length,
    });
  }

  // Route: /api/top-picks
  if (req.url.includes('/api/top-picks')) {
    try {
      const picks = await getTopPicks();
      return res.status(200).json({
        success: true,
        data: picks,
        generated: fcaLists.generated,
        totalActive: fcaLists.totalActive,
        pureCriteria1Count: fcaLists.pureCriteria1.length,
      });
    } catch (err) {
      console.error('[top-picks]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Route: /api/evaluate?ticker=XXX
  const ticker = (req.query.ticker || '').trim().toUpperCase();
  if (!ticker) return res.status(400).json({ error: 'Missing ticker' });

  if (!ALL_ACTIVE_FCA.has(ticker)) {
    return res.status(200).json({
      success: false,
      notFCA: true,
      error: `${ticker} is not an FCA stock. This dashboard only tracks FCA graduation possibility.`
    });
  }

  const isPureCriteria1 = PURE_CRITERIA_1.has(ticker);
  const criteriaInfo = FCA_CRITERIA[ticker] || '1';
  const isSuspended = SUSPENDED_CRITERIA.has(ticker);

  if (isSuspended) {
    return res.status(200).json({
      success: false,
      suspended: true,
      error: `${ticker} is currently suspended from trading (FCA criteria ${criteriaInfo}). Graduation tracking is not applicable.`
    });
  }

  try {
    const result = await evaluateTicker(ticker);
    res.status(200).json({
      success: true,
      data: result,
      isFCA: true,
      isPureCriteria1,
      criteria: criteriaInfo,
      warning: isPureCriteria1 ? null : `${ticker} is criteria ${criteriaInfo} — not pure criteria 1. This dashboard only tracks graduation possibility. Multi-criteria stocks may have additional suspension or delisting risks.`
    });
  } catch (err) {
    console.error(`[evaluate] ${ticker}:`, err.message);
    res.status(500).json({ error: err.message });
  }
};
