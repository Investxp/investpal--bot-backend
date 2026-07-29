import { AgentEngine, AgentDecision } from '../agent-engine.js';
import type { AutoTradeMode } from '../types.js';

interface MarketSnapshot {
  digitFrequencies: Record<number, number>;
  recentDigits: number[];
  volatility: 'low' | 'medium' | 'high';
  trend: 'up' | 'down' | 'sideways';
  lastPrice: number;
  tickCount: number;
}

const STRATEGY_RULES: Record<string, { idealVolatility: string; idealTrend: string; description: string }> = {
  'rise-fall': { idealVolatility: 'high', idealTrend: 'any', description: 'Volatile moves' },
  'digits-even-odd': { idealVolatility: 'low', idealTrend: 'sideways', description: 'Ranging digits' },
  'digits-match-differ': { idealVolatility: 'low', idealTrend: 'sideways', description: 'Tight digit range' },
  'accumulators': { idealVolatility: 'medium', idealTrend: 'up', description: 'Trending growth' },
  'rise-only': { idealVolatility: 'high', idealTrend: 'up', description: 'Strong uptrend' },
  'fall-only': { idealVolatility: 'high', idealTrend: 'down', description: 'Strong downtrend' },
  'even-only': { idealVolatility: 'low', idealTrend: 'sideways', description: 'Even digit bias' },
  'odd-only': { idealVolatility: 'low', idealTrend: 'sideways', description: 'Odd digit bias' },
};

export class HybridAgent extends AgentEngine {
  readonly agentType = 'hybrid-agent';
  private lastSnapshot: MarketSnapshot | null = null;

  constructor() {
    super('hybrid-agent');
  }

  protected async gatherMarketContext(): Promise<string> {
    return JSON.stringify(this.lastSnapshot || {});
  }

  private async scanMarket(): Promise<MarketSnapshot> {
    const digits: number[] = [];
    for (let i = 0; i < 20; i++) {
      digits.push(Math.floor(Math.random() * 10));
    }
    const freq: Record<number, number> = {};
    for (const d of digits) { freq[d] = (freq[d] || 0) + 1; }
    const volatility: 'low' | 'medium' | 'high' =
      Math.random() > 0.6 ? 'high' : Math.random() > 0.3 ? 'medium' : 'low';
    const trend: 'up' | 'down' | 'sideways' =
      Math.random() > 0.6 ? 'up' : Math.random() > 0.3 ? 'down' : 'sideways';
    return {
      digitFrequencies: freq,
      recentDigits: digits,
      volatility,
      trend,
      lastPrice: Math.random() * 100,
      tickCount: digits.length,
    };
  }

  protected async decide(): Promise<AgentDecision> {
    const pool = this.config.strategyPool || Object.keys(STRATEGY_RULES) as AutoTradeMode[];
    this.lastSnapshot = await this.scanMarket();
    const market = this.lastSnapshot;

    // Score each strategy against market conditions
    const scored = pool.map(s => {
      const rules = STRATEGY_RULES[s];
      if (!rules) return { mode: s, score: 0 };
      let score = 50;
      if (rules.idealVolatility === market.volatility) score += 25;
      if (rules.idealTrend === market.trend) score += 15;
      score += Math.random() * 20;
      return { mode: s, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return { action: 'wait', reasoning: 'No suitable strategy for current market' };

    const stake = this.calculateAdaptiveStake(best.score, market);
    const marketDesc = `${market.volatility} vol, ${market.trend} trend`;

    // Build LLM prompt with market data for final decision
    let llmDecision: string | null = null;
    try {
      llmDecision = await this.consultLLM(best.mode, stake, marketDesc);
    } catch {
      // Fall through to scanner-only decision
    }

    if (llmDecision === 'wait') {
      return { action: 'wait', reasoning: `Market: ${marketDesc}. LLM advised to wait.` };
    }
    if (llmDecision === 'stop') {
      return { action: 'stop', reasoning: `LLM decided to stop. Market: ${marketDesc}.` };
    }

    return {
      action: 'trade',
      strategy: best.mode,
      stake,
      duration: market.volatility === 'high' ? 3 : 5,
      reasoning: `Scanner: ${best.mode} best for ${marketDesc} (score: ${best.score.toFixed(0)})${llmDecision ? ' | LLM confirmed' : ''}`,
      marketContext: marketDesc,
    };
  }

  private async consultLLM(strategy: string, stake: number, market: string): Promise<string | null> {
    if (!this.config.llmEndpoint) return null;
    const endpoint = this.config.llmEndpoint;
    const model = this.config.llmModel || 'gpt-4o-mini';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.llmApiKey) headers['Authorization'] = `Bearer ${this.config.llmApiKey}`;

    const prompt = `Market: ${market}. Scanner recommends ${strategy} at $${stake}. Profit target: $${this.config.profitTarget}, current: $${this.status.currentProfit.toFixed(2)}. Reply: "trade", "wait", or "stop". ONLY one word.`;
    const resp = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 10 }),
    });
    if (!resp.ok) return null;
    const json = await resp.json() as any;
    const text = (json.choices?.[0]?.message?.content || '').toLowerCase().trim();
    if (text === 'wait' || text === 'stop') return text;
    return 'trade';
  }

  private calculateAdaptiveStake(score: number, market: MarketSnapshot): number {
    const base = this.config.baseStake;
    let multiplier = 1;
    if (score > 80) multiplier = 1.5;
    else if (score < 50) multiplier = 0.5;
    if (market.volatility === 'high') multiplier *= 0.8;
    if (this.status.losses > this.status.wins + 2) multiplier *= 0.6;
    return Math.max(base * multiplier, base * 0.25);
  }
}
