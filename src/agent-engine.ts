import { store } from './store.js';
import { DerivEngine } from './deriv-engine.js';
import { DerivClient } from './deriv-ws.js';
import type { TradeConfig, AutoTradeMode } from './types.js';

export type AgentType = 'strategy-rotator' | 'llm-agent' | 'hybrid-agent';

export interface AgentConfig {
  agentType: AgentType;
  profitTarget: number;
  maxLoss: number;
  maxTrades: number;
  maxDurationMinutes: number;
  baseStake: number;
  symbol?: string;
  strategyPool?: AutoTradeMode[];
  llmEndpoint?: string;
  llmApiKey?: string;
  llmModel?: string;
  scannerInterval?: number;
}

export interface AgentDecision {
  action: 'trade' | 'wait' | 'stop' | 'switch_strategy';
  strategy?: AutoTradeMode;
  stake?: number;
  duration?: number;
  reasoning: string;
  marketContext?: string;
}

export interface AgentStatus {
  agentType: AgentType;
  isRunning: boolean;
  profitTarget: number;
  currentProfit: number;
  totalTrades: number;
  wins: number;
  losses: number;
  currentStrategy: string;
  lastDecision: AgentDecision | null;
  decisionHistory: AgentDecision[];
  logs: string[];
  startedAt: string | null;
  elapsedMinutes: number;
}

export abstract class AgentEngine {
  readonly agentType: AgentType;
  protected config!: AgentConfig;
  protected _isRunning = false;
  protected derivClient: DerivClient | null = null;
  protected status: AgentStatus;
  protected derivEngine: DerivEngine | null = null;

  constructor(type: AgentType) {
    this.agentType = type;
    this.status = {
      agentType: type,
      isRunning: false,
      profitTarget: 0,
      currentProfit: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      currentStrategy: 'idle',
      lastDecision: null,
      decisionHistory: [],
      logs: [],
      startedAt: null,
      elapsedMinutes: 0,
    };
  }

  get isRunning() { return this._isRunning; }
  getStatus() { return this.status; }

  async start(config: AgentConfig, deriv: DerivClient) {
    this.config = config;
    this.derivClient = deriv;
    this._isRunning = true;
    this.status = {
      agentType: this.agentType,
      isRunning: true,
      profitTarget: config.profitTarget,
      currentProfit: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      currentStrategy: 'initializing',
      lastDecision: null,
      decisionHistory: [],
      logs: [],
      startedAt: new Date().toISOString(),
      elapsedMinutes: 0,
    };
    this.log(`Agent started - target: $${config.profitTarget}, max loss: $${config.maxLoss}`);
    store.addLog(`[Agent:${this.agentType}] Started - target: $${config.profitTarget}`, 'info');
    store.broadcast();
    await this.runLoop();
  }

  async stop(reason?: string) {
    this._isRunning = false;
    if (this.derivEngine) await this.derivEngine.stop(reason || 'Agent stopped');
    this.status.isRunning = false;
    this.log(`Agent stopped${reason ? ': ' + reason : ''}`);
    store.addLog(`[Agent] Stopped${reason ? ': ' + reason : ''}`, 'warn');
    store.broadcast();
  }

  protected abstract decide(): Promise<AgentDecision>;
  protected abstract gatherMarketContext(): Promise<string>;

  protected async runLoop() {
    const startTime = Date.now();
    while (this._isRunning) {
      this.status.elapsedMinutes = (Date.now() - startTime) / 60000;
      if (this.status.elapsedMinutes >= this.config.maxDurationMinutes) {
        this.log(`Max duration (${this.config.maxDurationMinutes}m) reached`);
        await this.stop('Time limit reached');
        return;
      }
      if (this.status.currentProfit <= -this.config.maxLoss) {
        this.log(`Max loss ($${this.config.maxLoss}) reached`);
        await this.stop('Max loss hit');
        return;
      }
      if (this.status.currentProfit >= this.config.profitTarget) {
        this.log(`Profit target ($${this.config.profitTarget}) reached!`);
        await this.stop('Profit target reached');
        return;
      }
      if (this.config.maxTrades > 0 && this.status.totalTrades >= this.config.maxTrades) {
        this.log(`Max trades (${this.config.maxTrades}) reached`);
        await this.stop('Max trades reached');
        return;
      }

      try {
        const decision = await this.decide();
        this.status.lastDecision = decision;
        this.status.decisionHistory.push(decision);
        this.log(`[${decision.action}] ${decision.reasoning}`);

        if (decision.action === 'trade' && decision.strategy) {
          this.status.currentStrategy = decision.strategy;
          await this.executeTrade(decision);
        } else if (decision.action === 'switch_strategy') {
          this.status.currentStrategy = decision.strategy || 'unknown';
          this.log(`Switched strategy to ${decision.strategy}`);
        } else if (decision.action === 'stop') {
          await this.stop('Agent decided to stop');
          return;
        }
        store.broadcast();
      } catch (err: any) {
        this.log(`Error: ${err.message}`);
        store.addLog(`[Agent] Round error: ${err.message}`, 'error');
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  protected async executeTrade(decision: AgentDecision) {
    if (!this.derivClient) return;
    const stake = decision.stake || this.config.baseStake;

    const tradeConfig: TradeConfig = {
      platform: 'deriv',
      mode: decision.strategy || 'rise-fall',
      symbol: this.config.symbol || 'R_100',
      baseStake: stake,
      duration: decision.duration || 5,
      durationUnit: 't',
      martingaleMultiplier: 2,
      takeProfit: this.config.profitTarget,
      stopLoss: this.config.maxLoss,
      selectedDigit: [5],
      growthRate: 0.01,
      isHedgeMode: false,
      isAlternateMode: false,
      alternateFrequency: 1,
    };

    this.derivEngine = new DerivEngine(this.derivClient);
    await this.derivEngine.start(tradeConfig);
    await new Promise(r => setTimeout(r, 5000));
    await this.derivEngine.stop();
    this.status.totalTrades++;
    this.log(`Trade executed: ${decision.strategy} @ $${stake}`);
  }

  protected log(msg: string) {
    this.status.logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (this.status.logs.length > 200) this.status.logs.splice(0, 50);
  }
}
