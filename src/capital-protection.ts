export type CapitalProtectionMode = 'STOP_RESET' | 'CONTINUE_LOCK' | 'EXCESS_ONLY';

export type CapitalProtectionInput = {
  realizedProfit: number;
  unrealizedProfit: number;
  exposure: number;
  balance: number;
  equity: number;
  protectedProfit?: number;
  maxExposure?: number;
  protectedProfitThreshold?: number;
  maxDrawdown?: number;
};

export type CapitalProtectionDecision = {
  allowed: boolean;
  mode: CapitalProtectionMode;
  protectedProfit: number;
  reason?: string;
  blocked: boolean;
};

export type CapitalProtectionState = CapitalProtectionDecision & {
  balance: number;
  equity: number;
  exposure: number;
  realizedProfit: number;
  unrealizedProfit: number;
};

export function evaluateCapitalProtection(input: CapitalProtectionInput): CapitalProtectionDecision {
  const maxExposure = input.maxExposure ?? 250;
  const protectedProfitThreshold = input.protectedProfitThreshold ?? 80;
  const maxDrawdown = input.maxDrawdown ?? 150;
  const protectedProfit = input.protectedProfit ?? 0;

  if (input.exposure > maxExposure) {
    return {
      allowed: false,
      mode: 'STOP_RESET',
      protectedProfit,
      blocked: true,
      reason: `Exposure (${input.exposure}) exceeds maximum (${maxExposure})`,
    };
  }

  const drawdown = Math.max(0, input.balance - input.equity);
  if (drawdown > maxDrawdown) {
    return {
      allowed: false,
      mode: 'STOP_RESET',
      protectedProfit,
      blocked: true,
      reason: `Drawdown (${drawdown}) exceeds maximum (${maxDrawdown})`,
    };
  }

  const nextProtectedProfit = input.realizedProfit > protectedProfitThreshold ? protectedProfitThreshold : protectedProfit;
  if (input.realizedProfit >= protectedProfitThreshold) {
    return {
      allowed: true,
      mode: 'CONTINUE_LOCK',
      protectedProfit: nextProtectedProfit,
      blocked: false,
    };
  }

  return {
    allowed: true,
    mode: 'STOP_RESET',
    protectedProfit: nextProtectedProfit,
    blocked: false,
  };
}

export function createCapitalProtectionEngine(defaults: {
  initialBalance: number;
  maxExposure: number;
  protectedProfitThreshold: number;
  maxDrawdown: number;
}) {
  const state: CapitalProtectionState = {
    allowed: true,
    mode: 'STOP_RESET',
    protectedProfit: 0,
    blocked: false,
    balance: defaults.initialBalance,
    equity: defaults.initialBalance,
    exposure: 0,
    realizedProfit: 0,
    unrealizedProfit: 0,
  };

  return {
    getState(): CapitalProtectionState {
      return { ...state };
    },
    applyTrade(input: {
      realizedProfit: number;
      unrealizedProfit: number;
      exposure: number;
      balance: number;
      equity: number;
    }): CapitalProtectionState {
      const decision = evaluateCapitalProtection({
        realizedProfit: input.realizedProfit,
        unrealizedProfit: input.unrealizedProfit,
        exposure: input.exposure,
        balance: input.balance,
        equity: input.equity,
        protectedProfit: state.protectedProfit,
        maxExposure: defaults.maxExposure,
        protectedProfitThreshold: defaults.protectedProfitThreshold,
        maxDrawdown: defaults.maxDrawdown,
      });

      state.allowed = decision.allowed;
      state.mode = decision.mode;
      state.protectedProfit = decision.protectedProfit;
      state.blocked = decision.blocked;
      state.reason = decision.reason;
      state.balance = input.balance;
      state.equity = input.equity;
      state.exposure = input.exposure;
      state.realizedProfit = input.realizedProfit;
      state.unrealizedProfit = input.unrealizedProfit;

      return { ...state };
    },
  };
}
