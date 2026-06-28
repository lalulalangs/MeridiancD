import { log } from "../logger.js";

const METRORA_OHLCV_URL = "https://dlmm.datapi.meteora.ag/pools";

/**
 * Fetch OHLCV candles from Meteora Public API.
 * Returns array of { open, high, low, close, volume } sorted oldest first.
 */
async function fetchMeteoraOHLCV(poolAddress, { timeframe = "5m", limit = 30 } = {}) {
  const url = `${METRORA_OHLCV_URL}/${poolAddress}/ohlcv?timeframe=${timeframe}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora OHLCV ${res.status}: ${await res.text().catch(() => "")}`);
  const json = await res.json();
  return (json.data || []).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Calculate RSI (Relative Strength Index).
 * Uses smoothed averages (Wilder's method), not simple average.
 */
function calculateRSI(closes, period = 2) {
  if (closes.length < period + 1) return null;

  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }

  // Initial average gain/loss (simple average of first `period` changes)
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    if (changes[i] > 0) avgGain += changes[i];
    else avgLoss += Math.abs(changes[i]);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smoothed averages for subsequent periods
  for (let i = period; i < changes.length; i++) {
    const gain = changes[i] > 0 ? changes[i] : 0;
    const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate Bollinger Bands (SMA ± 2 × stddev).
 * Returns { upper, middle, lower } for the most recent candle.
 */
function calculateBollingerBands(closes, period = 20) {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const sum = slice.reduce((a, b) => a + b, 0);
  const sma = sum / period;
  const variance = slice.reduce((acc, c) => acc + (c - sma) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);

  return {
    upper: sma + 2 * stddev,
    middle: sma,
    lower: sma - 2 * stddev,
  };
}

/**
 * Calculate EMA (Exponential Moving Average).
 */
function calculateEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA as seed
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Calculate full EMA series for given values.
 */
function calculateEMASeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const result = [];
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period - 1; i < values.length; i++) {
    if (i === period - 1) {
      // seed value — keep it
    } else {
      ema = values[i] * k + ema * (1 - k);
    }
    result.push(ema);
  }
  return result;
}

/**
 * Calculate MACD(12, 26, 9) and histogram.
 * Returns { macdLine, signalLine, histogram, previousHistogram }.
 * "first green histogram" = histogram > 0 && previousHistogram <= 0.
 */
function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;

  const ema12 = calculateEMASeries(closes, fast);
  const ema26 = calculateEMASeries(closes, slow);

  // Align to the longer EMA
  const offset = slow - fast;
  const macdValues = [];
  for (let i = offset; i < ema12.length; i++) {
    macdValues.push(ema12[i] - ema26[i]);
  }

  if (macdValues.length < signal) return null;

  const signalValues = calculateEMASeries(macdValues, signal);
  // Signal line has `signal - 1` fewer entries due to seed, trim MACD to match
  const trimmedMacd = macdValues.slice(macdValues.length - signalValues.length);

  const histogram = trimmedMacd.map((m, i) => m - signalValues[i]);
  const current = histogram[histogram.length - 1];
  const previous = histogram.length >= 2 ? histogram[histogram.length - 2] : null;

  return {
    macdLine: trimmedMacd[trimmedMacd.length - 1] ?? null,
    signalLine: signalValues[signalValues.length - 1] ?? null,
    histogram: current ?? null,
    previousHistogram: previous,
  };
}

/**
 * Evil Panda exit strategy — technical overbought check using Meteora Public API.
 *
 * Fetches 5m OHLCV from Meteora and calculates locally:
 *   - RSI(2)
 *   - Bollinger Bands Upper (20-period)
 *   - MACD(12,26,9) histogram with previous value for crossover detection
 *
 * Returns { confirmed, reason } where confirmed is true when:
 *   (RSI(2) > 90 AND Price > BB Upper)
 *   OR (RSI(2) > 90 AND MACD histogram just turned positive)
 */
export async function checkEvilPandaOverboughtFromMeteora(poolAddress, { timeframe = "5m", ohlcvLimit = 100 } = {}) {
  try {
    const candles = await fetchMeteoraOHLCV(poolAddress, { timeframe, limit: ohlcvLimit });
    if (candles.length < 3) {
      return {
        confirmed: false,
        skipped: true,
        reason: `Evil Panda: insufficient OHLCV data (${candles.length} candles, need >= 3)`,
      };
    }

    const closes = candles.map((c) => c.close);

    // RSI(2) — needs at least 3 candles
    const rsi = calculateRSI(closes, 2);
    const rsiOverbought = rsi != null && rsi > 90;

    // Bollinger Bands (20) — skip if <20 candles, return null
    const bb = closes.length >= 20 ? calculateBollingerBands(closes, 20) : null;
    const close = closes[closes.length - 1];

    // MACD (12, 26, 9) — skip if <37 candles, return null
    const macd = closes.length >= 37 ? calculateMACD(closes, 12, 26, 9) : null;

    // Condition A: RSI(2) > 90 AND Price > BB Upper
    const bbOverbought = rsiOverbought && bb != null && close != null && bb.upper != null && close > bb.upper;

    // Condition B: RSI(2) > 90 AND MACD first green histogram
    const macdFirstGreen = rsiOverbought &&
      macd?.histogram != null && macd.histogram > 0 &&
      macd.previousHistogram != null && macd.previousHistogram <= 0;

    if (bbOverbought || macdFirstGreen) {
      const reasons = [];
      if (bbOverbought) reasons.push(`RSI(2)=${rsi.toFixed(1)} > 90, Close=${close.toFixed(10)} > BB Upper=${bb.upper.toFixed(10)}`);
      if (macdFirstGreen) reasons.push(`RSI(2)=${rsi.toFixed(1)} > 90, MACD hist ${macd.previousHistogram.toFixed(10)}→${macd.histogram.toFixed(10)} (first green)`);
      return {
        confirmed: true,
        reason: `Evil Panda overbought: ${reasons.join(" | ")}`,
      };
    }

    const details = [`RSI(2)=${rsi?.toFixed(1) ?? "?"}`];
    if (bb) details.push(`BB Upper=${bb.upper.toFixed(10)}`);
    if (macd) details.push(`MACD hist=${macd.histogram.toFixed(10)}`);
    details.push(`candles=${candles.length}`);

    return {
      confirmed: false,
      reason: `Evil Panda: ${details.join(" ")} | Close=${close?.toFixed(10) ?? "?"}`,
    };
  } catch (error) {
    return {
      confirmed: false,
      skipped: true,
      reason: `Evil Panda Meteora indicator check failed: ${error.message}`,
    };
  }
}
