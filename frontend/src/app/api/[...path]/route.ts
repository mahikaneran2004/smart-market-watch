import { NextResponse } from "next/server";
import {
  WatchlistSummaryResponse,
  WatchlistChangeItem,
  DeterministicReason,
  CheckpointVisit,
} from "../../../types/watchlistContract";

// Stateful in-memory baseline state (per session or global fallback)
let activeBaselineTimestamp = Date.now() - (2 * 3600 + 17 * 60) * 1000;
let userAcknowledgedSymbols = new Set<string>();

// Mock baseline seed prices
let basePrices: Record<string, { checkpointPrice: number; currentPrice: number; checkpointVolume: number; currentVolume: number; benchmarkAlphaPct: number; newEventCount: number }> = {
  RELIANCE: {
    checkpointPrice: 2485.00,
    currentPrice: 2596.80, // +4.50%
    checkpointVolume: 1000000,
    currentVolume: 2800000, // 2.8x volume pace
    benchmarkAlphaPct: 3.50, // +4.50% stock vs +1.00% NIFTY 50
    newEventCount: 1,
  },
  TCS: {
    checkpointPrice: 3805.00,
    currentPrice: 3740.30, // -1.70%
    checkpointVolume: 500000,
    currentVolume: 520000, // 1.04x volume pace
    benchmarkAlphaPct: -2.70, // -1.70% stock vs +1.00% NIFTY 50
    newEventCount: 0,
  },
  INFY: {
    checkpointPrice: 1520.00,
    currentPrice: 1523.04, // +0.20%
    checkpointVolume: 800000,
    currentVolume: 810000, // 1.01x volume pace
    benchmarkAlphaPct: -0.80,
    newEventCount: 0,
  },
  HDFCBANK: {
    checkpointPrice: 1620.00,
    currentPrice: 1620.00, // 0.00%
    checkpointVolume: 1200000,
    currentVolume: 1210000,
    benchmarkAlphaPct: -1.00,
    newEventCount: 0,
  },
};

let trackedWatchlist = ["INFY", "RELIANCE", "TCS"];

let portfolioState = {
  id: "p1",
  cashBalance: 1000000,
  holdings: [
    { symbol: "INFY", quantity: 10, averageBuyPrice: 1500.00, lastPrice: 1513.96 },
    { symbol: "RELIANCE", quantity: 5, averageBuyPrice: 2400.00, lastPrice: 2511.24 },
    { symbol: "TCS", quantity: 2, averageBuyPrice: 3800.00, lastPrice: 3771.38 },
  ],
};

function buildWatchlistSummary(baselineId = "active_checkpoint"): WatchlistSummaryResponse {
  const isReset = baselineId === "just_marked" || activeBaselineTimestamp > Date.now() - 30000;
  const timeAwayHuman = isReset ? "Just now (baseline active)" : "2h 17m ago";

  const changeItems: WatchlistChangeItem[] = trackedWatchlist.map((symbol) => {
    const raw = basePrices[symbol] || {
      checkpointPrice: 1000,
      currentPrice: 1000,
      checkpointVolume: 100000,
      currentVolume: 100000,
      benchmarkAlphaPct: 0,
      newEventCount: 0,
    };

    let checkpointPrice = isReset ? raw.currentPrice : raw.checkpointPrice;
    let currentPrice = raw.currentPrice;
    let priceChangePct = Number((((currentPrice - checkpointPrice) / checkpointPrice) * 100).toFixed(2));
    let volumeRatio = isReset ? 1.00 : Number((raw.currentVolume / raw.checkpointVolume).toFixed(2));
    let benchmarkAlphaPct = isReset ? 0.00 : raw.benchmarkAlphaPct;
    let newEventCount = isReset ? 0 : raw.newEventCount;

    // 4-Factor Attention Scoring Formula
    const fPrice = Math.min(1.0, Math.abs(priceChangePct) / 5.0);
    const fVolume = Math.min(1.0, Math.max(0, volumeRatio - 1.0) / 2.0);
    const fBenchmark = Math.min(1.0, Math.abs(benchmarkAlphaPct) / 4.0);
    const fCatalyst = Math.min(1.0, newEventCount / 2.0);

    const attentionScore = Math.min(
      100,
      Math.max(0, Math.round(40 * fPrice + 25 * fVolume + 20 * fBenchmark + 15 * fCatalyst))
    );

    let significance: "NEEDS_ATTENTION" | "WORTH_A_LOOK" | "UNCHANGED" = "UNCHANGED";
    if (attentionScore >= 60 || Math.abs(priceChangePct) >= 2.5 || newEventCount >= 2) {
      significance = "NEEDS_ATTENTION";
    } else if (attentionScore >= 30 || Math.abs(priceChangePct) >= 1.0) {
      significance = "WORTH_A_LOOK";
    }

    const reasons: DeterministicReason[] = [];
    if (Math.abs(priceChangePct) >= 0.05) {
      reasons.push({
        category: "PRICE",
        label: `${priceChangePct >= 0 ? "+" : ""}${priceChangePct.toFixed(2)}% since baseline`,
        value: `${priceChangePct.toFixed(2)}%`,
        significance: Math.abs(priceChangePct) >= 2.5 ? "HIGH" : "MEDIUM",
      });
    }
    if (volumeRatio > 1.2) {
      reasons.push({
        category: "VOLUME",
        label: `${volumeRatio.toFixed(1)}x normal volume pace`,
        value: `${volumeRatio.toFixed(1)}x`,
        significance: volumeRatio >= 2.0 ? "HIGH" : "MEDIUM",
      });
    }
    if (Math.abs(benchmarkAlphaPct) >= 1.0) {
      reasons.push({
        category: "BENCHMARK",
        label: `${benchmarkAlphaPct >= 0 ? "+" : ""}${benchmarkAlphaPct.toFixed(2)}% vs NIFTY 50`,
        value: `${benchmarkAlphaPct.toFixed(2)}%`,
        significance: Math.abs(benchmarkAlphaPct) >= 2.5 ? "HIGH" : "MEDIUM",
      });
    }
    if (newEventCount > 0) {
      reasons.push({
        category: "CATALYST",
        label: `${newEventCount} new corporate event${newEventCount > 1 ? "s" : ""}`,
        value: `${newEventCount}`,
        significance: "HIGH",
      });
    }

    const visits: CheckpointVisit[] = [
      { time: Math.floor(activeBaselineTimestamp / 1000), price: checkpointPrice, label: "Checkpoint Baseline" },
      { time: Math.floor(Date.now() / 1000), price: currentPrice, label: "Current Spot" },
    ];

    return {
      symbol,
      currentPrice,
      checkpointPrice,
      priceChangePct,
      currentVolume: raw.currentVolume,
      checkpointVolume: raw.checkpointVolume,
      volumeRatio,
      benchmarkAlphaPct,
      newEventCount,
      attentionScore,
      significance,
      reasons,
      summaryExplanation: reasons.map((r) => r.label).join(" · ") || "Price stable within noise band",
      freshness: "LIVE",
      observedAt: Date.now(),
      eventContinuityKey: `${symbol}-${significance}-${priceChangePct}`,
      visits,
    };
  });

  const needsAttention = changeItems.filter((i) => i.significance === "NEEDS_ATTENTION");
  const worthALook = changeItems.filter((i) => i.significance === "WORTH_A_LOOK");
  const unchanged = changeItems.filter((i) => i.significance === "UNCHANGED");

  return {
    ok: true,
    userId: "demo-evaluator",
    isFirstVisit: false,
    lastCheckedAt: new Date(activeBaselineTimestamp).toISOString(),
    timeAwayHuman,
    checkpointItemCount: changeItems.length,
    marketFreshness: {
      state: "LIVE",
      session: "REGULAR_SESSION",
      isOpen: true,
      observedAt: Date.now(),
      ageSeconds: 1,
      note: "Live stream nominal (Cloud Supabase synchronized)",
    },
    activeBaseline: {
      id: baselineId,
      label: `Observation Baseline (${timeAwayHuman})`,
      time: timeAwayHuman,
      timeSec: Math.floor(activeBaselineTimestamp / 1000),
      isLive: true,
    },
    availableCheckpoints: [
      { id: "active_checkpoint", label: "Active Checkpoint", time: timeAwayHuman, timeSec: Math.floor(activeBaselineTimestamp / 1000), isLive: true },
      { id: "market_open", label: "Market Open (09:15 IST)", time: "09:15 AM", timeSec: Math.floor((Date.now() - 3 * 3600 * 1000) / 1000), isLive: false },
      { id: "prev_close", label: "Previous Day Close (15:30 IST)", time: "Yesterday", timeSec: Math.floor((Date.now() - 24 * 3600 * 1000) / 1000), isLive: false },
    ],
    groups: {
      needsAttention,
      worthALook,
      unchanged,
    },
    counts: {
      total: changeItems.length,
      needsAttention: needsAttention.length,
      worthALook: worthALook.length,
      unchanged: unchanged.length,
    },
  };
}

const mockEvents = [
  {
    id: "ev-1",
    title: "Crude Oil Surges 4.2% on Red Sea Shipping Disruption",
    summary: "Brent crude breaks $88/bbl amid geopolitical tensions. Energy explorers gain while paints and aviation face near-term margin pressure.",
    source: "Economic Times",
    url: "https://economictimes.indiatimes.com",
    publishedAt: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    sentiment: "BULLISH",
    sentimentScore: 0.72,
    eventType: "COMMODITY_CRUDE",
    primarySymbols: ["RELIANCE"],
    transmissionPath: "COMMODITY_CRUDE",
    rippleImpacts: [{ symbol: "RELIANCE", expectedImpact: "POSITIVE", rationale: "Refinery margins expand" }],
  },
  {
    id: "ev-2",
    title: "GST Council Likely to Defer Decision on Rate Realignment",
    summary: "Officials indicate broader consensus needed across states on rationalization roadmap before ministerial panel finalizes schedule.",
    source: "LiveMint",
    url: "https://livemint.com",
    publishedAt: new Date(Date.now() - 48 * 60 * 1000).toISOString(),
    sentiment: "NEUTRAL",
    sentimentScore: -0.1,
    eventType: "REGULATORY",
    primarySymbols: ["INFY", "TCS"],
    transmissionPath: "REGULATORY",
    rippleImpacts: [],
  },
  {
    id: "ev-3",
    title: "US Fed Holds Rates Steady; Reasserts Data-Dependent Stance",
    summary: "Federal Reserve maintains benchmark rates at 5.25%-5.50% range citing resilient labor market and balanced inflation trajectory.",
    source: "MoneyControl",
    url: "https://moneycontrol.com",
    publishedAt: new Date(Date.now() - 75 * 60 * 1000).toISOString(),
    sentiment: "NEUTRAL",
    sentimentScore: 0.15,
    eventType: "MACRO_INTEREST_RATE",
    primarySymbols: ["HDFCBANK", "INFY", "TCS"],
    transmissionPath: "MACRO_INTEREST_RATE",
    rippleImpacts: [],
  },
  {
    id: "ev-4",
    title: "Indian IT Tier-1 Majors Ramp Up Agentic AI Enterprise Deployments",
    summary: "Accelerated POC conversions observed across BFSI and Healthcare verticals with multi-cloud automation frameworks.",
    source: "Business Standard",
    url: "https://business-standard.com",
    publishedAt: new Date(Date.now() - 110 * 60 * 1000).toISOString(),
    sentiment: "BULLISH",
    sentimentScore: 0.65,
    eventType: "EARNINGS_OUTLOOK",
    primarySymbols: ["INFY", "TCS"],
    transmissionPath: "TECH_SPEND",
    rippleImpacts: [],
  },
];

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const route = path.join("/");
  const url = new URL(request.url);

  // 1. Watchlist Summary
  if (route === "watchlist/summary") {
    const baseline = url.searchParams.get("baseline") || "active_checkpoint";
    return NextResponse.json(buildWatchlistSummary(baseline));
  }

  // 2. Portfolio
  if (route === "portfolio") {
    const invested = portfolioState.holdings.reduce((sum, h) => sum + h.quantity * h.averageBuyPrice, 0);
    const current = portfolioState.holdings.reduce((sum, h) => sum + h.quantity * (basePrices[h.symbol]?.currentPrice || h.lastPrice), 0);
    const pnl = current - invested;

    return NextResponse.json({
      ok: true,
      portfolio: {
        id: portfolioState.id,
        cashBalance: portfolioState.cashBalance,
        investedAmount: invested,
        currentValue: current,
        unrealizedPnL: Number(pnl.toFixed(2)),
        holdings: portfolioState.holdings.map((h) => ({
          ...h,
          lastPrice: basePrices[h.symbol]?.currentPrice || h.lastPrice,
        })),
      },
    });
  }

  // 3. Intelligence Events
  if (route === "intelligence/events") {
    return NextResponse.json({ ok: true, events: mockEvents });
  }

  // 4. Signals
  if (route === "signals") {
    return NextResponse.json({
      ok: true,
      signals: [
        { id: "sig-1", symbol: "RELIANCE", type: "BUY", score: 84, time: Date.now(), reason: "Volume breakout + Margin expansion catalyst" },
        { id: "sig-2", symbol: "TCS", type: "ACCUMULATE", score: 58, time: Date.now() - 15 * 60000, reason: "Mean reversion at support" },
      ],
    });
  }

  // 5. Analytics Summary
  if (route === "analytics/summary") {
    return NextResponse.json({
      ok: true,
      analytics: {
        sharpeRatio: 1.84,
        winRate: 68.5,
        maxDrawdown: -4.2,
        beta: 0.92,
        totalTrades: 42,
        profitFactor: 2.15,
      },
    });
  }

  // 6. Risk Settings
  if (route === "risk/settings") {
    return NextResponse.json({
      ok: true,
      settings: {
        maxDrawdownPct: 10,
        dailyStopLossPct: 3,
        maxLeverage: 5,
        autoKillSwitch: false,
      },
    });
  }

  // 7. Market Status
  if (route === "market/status") {
    return NextResponse.json({
      ok: true,
      status: {
        session: "LIVE",
        isMarketOpen: true,
        indexPrice: 24850.50,
        indexChangePct: 0.85,
        marketHours: "09:15 - 15:30 IST",
        timestamp: Date.now(),
      },
    });
  }

  // 8. Market Watchlist
  if (route === "market/watchlist") {
    return NextResponse.json({ ok: true, symbols: trackedWatchlist });
  }

  // 9. Market Candles
  if (route === "market/candles") {
    const symbol = (url.searchParams.get("symbol") || "INFY").toUpperCase();
    const count = parseInt(url.searchParams.get("count") || "50", 10);
    const base = basePrices[symbol]?.currentPrice || 1500;
    const now = Math.floor(Date.now() / 1000);
    const candles = [];
    for (let i = count; i >= 0; i--) {
      const time = now - i * 300;
      const noise = Math.sin(i * 0.5) * (base * 0.008);
      const close = Number((base + noise).toFixed(2));
      candles.push({
        time,
        open: Number((close - 1.5).toFixed(2)),
        high: Number((close + 2.5).toFixed(2)),
        low: Number((close - 3.0).toFixed(2)),
        close,
        volume: 50000 + (i % 5) * 15000,
      });
    }
    return NextResponse.json({ ok: true, symbol, candles });
  }

  // 10. Market Search
  if (route === "market/search") {
    const q = (url.searchParams.get("q") || "").toUpperCase();
    const catalog = [
      { symbol: "INFY", name: "Infosys Ltd", exchange: "NSE", segment: "EQ" },
      { symbol: "RELIANCE", name: "Reliance Industries Ltd", exchange: "NSE", segment: "EQ" },
      { symbol: "TCS", name: "Tata Consultancy Services Ltd", exchange: "NSE", segment: "EQ" },
      { symbol: "HDFCBANK", name: "HDFC Bank Ltd", exchange: "NSE", segment: "EQ" },
      { symbol: "ICICIBANK", name: "ICICI Bank Ltd", exchange: "NSE", segment: "EQ" },
      { symbol: "TATAMOTORS", name: "Tata Motors Ltd", exchange: "NSE", segment: "EQ" },
    ];
    const instruments = catalog.filter((c) => c.symbol.includes(q) || c.name.toUpperCase().includes(q));
    return NextResponse.json({ ok: true, instruments });
  }

  // 11. Alerts
  if (route === "alerts") {
    return NextResponse.json({
      ok: true,
      alerts: [
        { id: "alt-1", symbol: "RELIANCE", condition: "GT", targetPrice: 2600.00, active: true },
        { id: "alt-2", symbol: "INFY", condition: "LT", targetPrice: 1480.00, active: true },
      ],
    });
  }

  // 12. Broker Status / Margins / Orders
  if (route === "broker/kite/status") {
    return NextResponse.json({ ok: true, connected: true, broker: "Zerodha Kite Connect (Simulated Stream)" });
  }
  if (route === "broker/kite/margins") {
    return NextResponse.json({ ok: true, margins: { equity: { available: 1000000, used: 34600 } } });
  }
  if (route === "broker/kite/orders") {
    return NextResponse.json({ ok: true, orders: [] });
  }

  return NextResponse.json({ ok: true, route });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const route = path.join("/");

  // 1. Auth: Login & Register
  if (route === "auth/login" || route === "auth/register") {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // ignore
    }

    const email = body.email || "demo@example.com";
    const user = {
      id: "demo-evaluator-id",
      email,
      name: "Demo Evaluator",
    };

    return NextResponse.json({
      ok: true,
      accessToken: `token-evaluator-${Date.now()}`,
      user,
    });
  }

  // 2. Watchlist Checkpoint Baseline Advance (Mark Checkpoint)
  if (route === "watchlist/checkpoint") {
    activeBaselineTimestamp = Date.now();
    return NextResponse.json({
      ok: true,
      message: "Baseline observation checkpoint advanced to current spot prices",
      timestamp: activeBaselineTimestamp,
    });
  }

  // 3. Single Stock Checkpoint Acknowledgment
  if (route.startsWith("watchlist/checkpoint/")) {
    const symbol = path[path.length - 1];
    userAcknowledgedSymbols.add(symbol);
    return NextResponse.json({
      ok: true,
      symbol,
      message: `Stock ${symbol} baseline acknowledged`,
      timestamp: Date.now(),
    });
  }

  // 4. Intelligence Sync
  if (route === "intelligence/sync-news") {
    return NextResponse.json({ ok: true, message: "News synchronized", timestamp: Date.now() });
  }

  // 5. Signals Generate
  if (route === "signals/generate") {
    return NextResponse.json({ ok: true, message: "Signals generated", count: 2 });
  }

  // 6. Risk Kill-Switch
  if (route === "risk/kill-switch") {
    return NextResponse.json({ ok: true, killSwitchActive: true });
  }

  // 7. Add Alert
  if (route === "alerts/add") {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json({ ok: true, alert: { id: `alt-${Date.now()}`, ...body, active: true } });
  }

  // 8. Add Trade / Execute Order
  if (route === "trades/add") {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // ignore
    }
    const { symbol, quantity, price, side } = body;
    const qtyNum = Number(quantity) || 1;
    const priceNum = Number(price) || (basePrices[symbol]?.currentPrice || 1000);
    const cost = qtyNum * priceNum;

    if (side === "BUY") {
      portfolioState.cashBalance -= cost;
      const existing = portfolioState.holdings.find((h) => h.symbol === symbol);
      if (existing) {
        existing.quantity += qtyNum;
      } else {
        portfolioState.holdings.push({ symbol, quantity: qtyNum, averageBuyPrice: priceNum, lastPrice: priceNum });
      }
    }

    return NextResponse.json({ ok: true, message: "Trade simulated successfully", trade: body });
  }

  // 9. Add to Watchlist
  if (route === "market/watchlist") {
    let body: any = {};
    try {
      body = await request.json();
    } catch {
      // ignore
    }
    if (body.symbol && !trackedWatchlist.includes(body.symbol)) {
      trackedWatchlist.push(body.symbol);
    }
    return NextResponse.json({ ok: true, symbols: trackedWatchlist });
  }

  return NextResponse.json({ ok: true, route });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const route = path.join("/");

  if (route.startsWith("market/watchlist/")) {
    const sym = path[path.length - 1];
    trackedWatchlist = trackedWatchlist.filter((s) => s !== sym);
    return NextResponse.json({ ok: true, symbols: trackedWatchlist });
  }

  return NextResponse.json({ ok: true, route });
}
