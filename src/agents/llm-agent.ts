import { AgentEngine, AgentDecision } from '../agent-engine.js';
import type { AutoTradeMode } from '../types.js';

const DEFAULT_LLM = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const STRATEGY_LIST = [
  'rise-fall', 'digits-even-odd', 'digits-match-differ', 'accumulators',
  'rise-only', 'fall-only', 'even-only', 'odd-only',
];

const systemPrompt = `You are an autonomous trading agent for Deriv.com binary options.
Your goal is to make profitable trades by choosing the best strategy and stake.

Available strategies and their optimal use:
- rise-fall: Best in volatile markets, predicts if price rises or falls
- digits-even-odd: Predict if last digit is even or odd — good for ranging markets
- digits-match-differ: Predict if digit matches/differs — tight spreads
- accumulators: Compound growth strategy — use in trending markets
- rise-only / fall-only: Single-direction in strong trends
- even-only / odd-only: Single-digit bias when digit shows pattern

Rules:
1. Only respond with valid JSON — no markdown, no explanation
2. Respond in this exact format:
{
  "action": "trade" | "wait" | "stop",
  "strategy": "rise-fall" | ...,
  "stake": <number>,
  "duration": <1-10 ticks>,
  "reasoning": "<brief reason for this decision>"
}
3. "wait" means skip this round (unfavorable conditions)
4. "stop" means end the session
5. Base stake is provided — adjust up for high confidence, down for low
6. Never risk more than 2x base stake on a single trade`;

export class LLMAgent extends AgentEngine {
  readonly agentType = 'llm-agent';

  constructor() {
    super('llm-agent');
  }

  protected async gatherMarketContext(): Promise<string> {
    const history = this.status.decisionHistory.slice(-10);
    const recentTrades = history.filter(d => d.action === 'trade');
    const wins = recentTrades.filter(d => d.reasoning.includes('win')).length;
    const losses = recentTrades.length - wins;
    const profit = this.status.currentProfit;
    return `Session: ${this.status.totalTrades} trades, ${this.status.wins}W/${this.status.losses}L, P&L: $${profit.toFixed(2)}`;
  }

  protected async decide(): Promise<AgentDecision> {
    const ctx = await this.gatherMarketContext();
    const prompt = `Current session context:
${ctx}
Profit target: $${this.config.profitTarget}
Current profit: $${this.status.currentProfit.toFixed(2)}
Base stake: $${this.config.baseStake}
Max loss allowed: $${this.config.maxLoss}
Total trades so far: ${this.status.totalTrades}

Recent decision history:
${this.status.decisionHistory.slice(-5).map(d =>
  `- ${d.action} ${d.strategy || ''} stake=${d.stake || '-'} reason="${d.reasoning}"`
).join('\n')}

What is your next decision?`;

    try {
      const body = JSON.stringify({
        model: this.config.llmModel || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 300,
      });

      const endpoint = this.config.llmEndpoint || DEFAULT_LLM;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.llmApiKey) headers['Authorization'] = `Bearer ${this.config.llmApiKey}`;

      const resp = await fetch(endpoint, { method: 'POST', headers, body });
      if (!resp.ok) throw new Error(`LLM API error: ${resp.status}`);

      const json = await resp.json() as any;
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty LLM response');

      const parsed = JSON.parse(content.replace(/```json|```/g, '').trim());

      if (parsed.action === 'trade' && parsed.strategy && STRATEGY_LIST.includes(parsed.strategy)) {
        return {
          action: 'trade',
          strategy: parsed.strategy as AutoTradeMode,
          stake: Math.min(parsed.stake || this.config.baseStake, this.config.baseStake * 3),
          duration: Math.min(Math.max(parsed.duration || 5, 1), 10),
          reasoning: parsed.reasoning || 'LLM decision',
          marketContext: ctx,
        };
      }

      if (parsed.action === 'stop') {
        return { action: 'stop', reasoning: parsed.reasoning || 'LLM decided to stop' };
      }

      return { action: 'wait', reasoning: parsed.reasoning || 'LLM advised to wait' };
    } catch (err: any) {
      this.log(`LLM call failed: ${err.message}`);
      return { action: 'wait', reasoning: `LLM error: ${err.message}` };
    }
  }
}
