export type Platform = 'deriv' | 'polymarket' | 'sx' | 'investpal';

export type AutoTradeMode =
  | 'rise-fall' | 'digits-even-odd' | 'digits-match-differ' | 'digits-over-under'
  | 'accumulators' | 'higher-lower' | 'touch-no-touch' | 'asian-up-down' | 'reset-call-put'
  | 'rise-only' | 'fall-only' | 'even-only' | 'odd-only' | 'match-only' | 'differ-only'
  | 'over-only' | 'under-only' | 'higher-only' | 'lower-only' | 'touch-only' | 'no-touch-only'
  | 'asian-up-only' | 'asian-down-only' | 'reset-call-only' | 'reset-put-only'
  | 'ai-auto-combo' | 'ai-auto-individual';

export interface TradeConfig {
  platform: Platform;
  mode: AutoTradeMode;
  symbol: string;
  baseStake: number;
  baseStake2?: number;
  duration: number;
  durationUnit: 't' | 's' | 'm' | 'h' | 'd';
  martingaleMultiplier: number;
  takeProfit: number;
  stopLoss: number;
  selectedDigit: number[];
  selectedDigit2?: number[];
  growthRate: number;
  isHedgeMode: boolean;
  isAlternateMode: boolean;
  alternateFrequency: number;
  recoveryMethod?: 'martingale' | 'reverse_martingale' | 'dalembert' | 'fibonacci' | 'oscars_grind' | 'ai_auto';
  ghostLossThreshold?: number;
  maxTradesLimit?: number;
  trailingProfitLock?: number;
  accumulatorAutoSellOffset?: number;
  aiSignalsDriven?: boolean;
  multiDigitObjectives?: string;
  aiStakeMode?: boolean;
  aiRecoveryMode?: boolean;
  aiGhostFloorMode?: boolean;
  aiMaxRunsMode?: boolean;
  aiTrailingLockMode?: boolean;
  aiDigitsMode?: boolean;
  martingaleSplitMode?: 'optional' | 'full';
  barrierOffset?: string;
  enableCoolOff?: boolean;
  coolOffConsecutiveLosses?: number;
  coolOffConsecutiveWins?: number;
  coolOffDuration?: number;
  burstMode?: 'parallel' | 'sequential';
  burstSize?: number;
  recoverySplitCount?: number;
  aiRandomCoolOff?: boolean;
}

export interface RunnerState {
  label: string;
  contractType: string;
  currentStake: number;
  isTrading: boolean;
  activeContractId: number | null;
  lastResult: 'win' | 'loss' | null;
  profit: number;
}

export interface TradeLog {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'error' | 'warn';
  message: string;
}

export interface TradeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  totalProfit: number;
  status: 'idle' | 'running' | 'completed' | 'stopped';
}

export interface TradeStatus {
  isRunning: boolean;
  stats: TradeStats;
  logs: TradeLog[];
  leg1: RunnerState;
  leg2: RunnerState;
  leg3: RunnerState;
}
