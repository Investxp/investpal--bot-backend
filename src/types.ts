export type Platform = 'deriv' | 'polymarket' | 'sx' | 'investpal';

export type AutoTradeMode =
  | 'rise-fall' | 'digits-even-odd' | 'digits-match-differ' | 'digits-over-under'
  | 'accumulators' | 'higher-lower' | 'touch-no-touch' | 'asian-up-down' | 'reset-call-put'
  | 'turbos' | 'ends-between-outside' | 'stays-between-goes-outside' | 'only-ups-only-downs'
  | 'rise-only' | 'fall-only' | 'even-only' | 'odd-only' | 'match-only' | 'differ-only'
  | 'over-only' | 'under-only' | 'higher-only' | 'lower-only' | 'touch-only' | 'no-touch-only'
  | 'asian-up-only' | 'asian-down-only' | 'reset-call-only' | 'reset-put-only'
  | 'turbo-long-only' | 'turbo-short-only'
  | 'ends-between-only' | 'ends-outside-only' | 'stays-between-only' | 'goes-outside-only'
  | 'only-ups-only' | 'only-downs-only'
  | 'ai-auto-combo' | 'ai-auto-individual'
  | 'ticks' | 'tick-high-only' | 'tick-low-only'
  | 'vanilla' | 'vanilla-call-only' | 'vanilla-put-only'
  | 'multipliers' | 'multipliers-up-only' | 'multipliers-down-only';

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
  recoveryMethod?: 'martingale' | 'reverse_martingale' | 'dalembert' | 'fibonacci' | 'oscars_grind' | 'ai_auto' | 'martingale_reverse';
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
  multiplier?: number;
  dealCancelSeconds?: number;
  reverseLossStyle?: 'flat' | 'step' | 'scale';
  multiplierMode?: 'fixed' | 'separate' | 'auto-max' | 'biased';
  martingaleMultiplier2?: number;
  biasedMultiplier?: number;
  // Match-Differ loss recovery
  mdRecoveryEnabled?: boolean;
  mdRecoveryLossTrigger?: number;
  mdRecoveryMode?: 'differ_only' | 'both_legs' | 'over_under';
  mdRecoveryMartingaleFactor?: number;
  mdRecoveryMaxRounds?: number;
  mdRecoveryTickWait?: number;
  mdRecoveryAnalysisWindow?: number;
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
