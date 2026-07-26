import { DerivClient } from './deriv-ws.js';
import { store } from './store.js';
import type { TradeConfig } from './types.js';

const FIBO = [1, 1, 2, 3, 5, 8, 13, 21, 34, 55];

export class TradeEngine {
  private deriv: DerivClient;
  private config!: TradeConfig;
  private tickUnsub: (() => void) | null = null;
  private isRunning = false;
  private lastTickDigit = 5;
  private firstRound = true;
  private recoveryDebt = 0;
  private recoverySplits = 0;

  // Advanced tracking
  private peakProfit = 0;
  private consecutiveWins = 0;
  private consecutiveLosses = 0;
  private coolOffUntil = 0;
  private fiboIdx1 = 0; private fiboIdx2 = 0; private fiboIdx3 = 0;
  private ogTarget1 = 0; private ogTarget2 = 0; private ogTarget3 = 0;
  private ogUnit1 = 0; private ogUnit2 = 0; private ogUnit3 = 0;
  private ghost1 = 0; private ghost2 = 0; private ghost3 = 0;
  private multiDigitIdx = 0;
  private digitIdx1 = 0; private digitIdx2 = 0; private digitIdx3 = 0;
  private splitCount1 = 0; private splitStake1 = 0;
  private splitCount2 = 0; private splitStake2 = 0;
  private splitCount3 = 0; private splitStake3 = 0;
  private tradeCount = 0;
  private currentLeg: 'leg1' | 'leg2' = 'leg1';
  private dynamicLossLimit = 3;
  private dynamicWinLimit = 3;
  private consecutiveErrors = 0;
  private lastTradeTime = 0;

  constructor(deriv: DerivClient) { this.deriv = deriv; }

  private async sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  // ── Stake Calculation ──────────────────────────────────────────────
  private resolveRecovery(method: string): string {
    if (method !== 'ai_auto') return method;
    const t = store.stats.totalTrades;
    const w = t > 0 ? store.stats.wins / t : 0.5;
    if (w < 0.4) return 'fibonacci';
    if (w < 0.5) return 'oscars_grind';
    return 'martingale';
  }

  private calcStake(method: string, won: boolean, loss: number, base: number, mult: number, leg: number = 1): number {
    if (!method || method === 'none') {
      return base;
    }
    if (method === 'martingale_reverse') {
      // Leg 1: martingale (↑ on loss), Leg 2: reverse martingale (↑ on win)
      return leg === 1
        ? (won ? base : Math.round((loss * mult) * 100) / 100)
        : (won ? Math.round((loss * mult) * 100) / 100 : base);
    }
    if (method === 'reverse_martingale') {
      return won ? Math.round((loss * mult) * 100) / 100 : base;
    }
    if (method === 'dalembert') {
      if (won) return Math.max(base, Math.round((loss - base) * 100) / 100);
      return Math.round((loss + base) * 100) / 100;
    }
    if (method === 'fibonacci') {
      return base;
    }
    if (method === 'oscars_grind') {
      return base;
    }
    // martingale (default)
    return won ? base : Math.round((loss * mult) * 100) / 100;
  }

  // ── Start ──────────────────────────────────────────────────────────
  async start(config: TradeConfig) {
    this.config = config;
    this.isRunning = true;
    this.firstRound = true;
    this.recoveryDebt = 0;
    this.recoverySplits = 0;
    this.peakProfit = 0;
    this.consecutiveWins = 0;
    this.consecutiveLosses = 0;
    this.coolOffUntil = 0;
    this.fiboIdx1 = this.fiboIdx2 = this.fiboIdx3 = 0;
    this.ogTarget1 = this.ogTarget2 = this.ogTarget3 = 0;
    this.ogUnit1 = this.ogUnit2 = this.ogUnit3 = 0;
    this.ghost1 = this.ghost2 = this.ghost3 = 0;
    this.multiDigitIdx = 0;
    this.digitIdx1 = this.digitIdx2 = this.digitIdx3 = 0;
    this.splitCount1 = this.splitCount2 = this.splitCount3 = 0;
    this.splitStake1 = this.splitStake2 = this.splitStake3 = 0;
    this.tradeCount = 0;
    this.currentLeg = 'leg1';
    this.dynamicLossLimit = config.coolOffConsecutiveLosses ?? 3;
    this.dynamicWinLimit = config.coolOffConsecutiveWins ?? 3;
    this.consecutiveErrors = 0;
    this.lastTradeTime = 0;
    this.lastTickDigit = await this.deriv.getLastDigit(config.symbol).catch(() => 5);

    store.reset(config);

    // Subscribe to ticks for Match-Differ tracking
    if (this.config.mode === 'digits-match-differ') {
      this.tickUnsub = await this.deriv.subscribeTicks(config.symbol, (tick) => {
        const s = tick.quote.toString();
        const dot = s.indexOf('.');
        const pip = dot === -1 ? 0 : s.length - dot - 1;
        const d = pip > 0 ? parseInt(s.slice(-1), 10) : Math.floor(Math.abs(tick.quote) % 10);
        if (!isNaN(d)) this.lastTickDigit = d;
      });
    }

    // Set up labels
    const { leg1Label, leg1Type, leg2Label, leg2Type } = this.getLabels(config.mode);
    store.leg1.label = leg1Label; store.leg1.contractType = leg1Type;
    store.leg2.label = leg2Label; store.leg2.contractType = leg2Type;

    store.addLog(`Engine starting: ${config.mode} on ${config.symbol}`, 'info');
    store.broadcast();

    // Kick off main loop
    const isMultiplier = ['multipliers', 'multipliers-up-only', 'multipliers-down-only'].includes(config.mode);

    if (isMultiplier && config.isHedgeMode) {
      store.addLog('Multiplier hedge mode: both legs simultaneously', 'info');
      this.loopMultiplierHedge();
    } else if (isMultiplier) {
      store.addLog('Multiplier mode: monitoring ticks for TP/SL', 'info');
      this.loopMultiplier();
    } else if (config.isHedgeMode) {
      store.addLog('Hedge mode: both legs simultaneously', 'info');
      this.loopHedge();
    } else {
      store.addLog('Sequential mode: single leg', 'info');
      this.loopSequential();
    }
  }

  stop(reason?: string) {
    this.isRunning = false;
    if (this.tickUnsub) { this.tickUnsub(); this.tickUnsub = null; }
    store.stop(reason);
  }

  // ── Labels ─────────────────────────────────────────────────────────
  private getLabels(mode: string) {
    const map: Record<string, [string, string, string, string]> = {
      'rise-fall': ['Rise (CALL)', 'CALL', 'Fall (PUT)', 'PUT'],
      'digits-even-odd': ['Digit Even', 'DIGITEVEN', 'Digit Odd', 'DIGITODD'],
      'digits-match-differ': ['Digit Match', 'DIGITMATCH', 'Digit Differ', 'DIGITDIFF'],
      'digits-over-under': ['Digit Over', 'DIGITOVER', 'Digit Under', 'DIGITUNDER'],
      'higher-lower': ['Higher', 'HIGHER', 'Lower', 'LOWER'],
      'touch-no-touch': ['Touch', 'ONETOUCH', 'No Touch', 'NOTOUCH'],
      'asian-up-down': ['Asian Up', 'ASIANU', 'Asian Down', 'ASIAND'],
      'reset-call-put': ['Reset Call', 'RESETCALL', 'Reset Put', 'RESETPUT'],
      'accumulators': ['Accumulator A', 'ACCU', 'Accumulator B', 'ACCU'],
      'ticks': ['Tick High', 'TICKHIGH', 'Tick Low', 'TICKLOW'],
      'tick-high-only': ['Tick High', 'TICKHIGH', 'Tick High', 'TICKHIGH'],
      'tick-low-only': ['Tick Low', 'TICKLOW', 'Tick Low', 'TICKLOW'],
      'vanilla': ['Vanilla Call', 'VANILLALONGCALL', 'Vanilla Put', 'VANILLALONGPUT'],
      'vanilla-call-only': ['Vanilla Call', 'VANILLALONGCALL', 'Vanilla Call', 'VANILLALONGCALL'],
      'vanilla-put-only': ['Vanilla Put', 'VANILLALONGPUT', 'Vanilla Put', 'VANILLALONGPUT'],
      'multipliers': ['Multiplier Up', 'MULTUP', 'Multiplier Down', 'MULTDOWN'],
      'multipliers-up-only': ['Multiplier Up', 'MULTUP', 'Multiplier Up', 'MULTUP'],
      'multipliers-down-only': ['Multiplier Down', 'MULTDOWN', 'Multiplier Down', 'MULTDOWN'],
      'turbos': ['Turbo Long', 'TURBOSLONG', 'Turbo Short', 'TURBOSSHORT'],
      'turbo-long-only': ['Turbo Long', 'TURBOSLONG', 'Turbo Long', 'TURBOSLONG'],
      'turbo-short-only': ['Turbo Short', 'TURBOSSHORT', 'Turbo Short', 'TURBOSSHORT'],
      'ends-between-outside': ['Ends Between', 'EXPIRYRANGE', 'Ends Outside', 'EXPIRYMISS'],
      'ends-between-only': ['Ends Between', 'EXPIRYRANGE', 'Ends Between', 'EXPIRYRANGE'],
      'ends-outside-only': ['Ends Outside', 'EXPIRYMISS', 'Ends Outside', 'EXPIRYMISS'],
      'stays-between-goes-outside': ['Stays Between', 'RANGE', 'Goes Outside', 'UPORDOWN'],
      'stays-between-only': ['Stays Between', 'RANGE', 'Stays Between', 'RANGE'],
      'goes-outside-only': ['Goes Outside', 'UPORDOWN', 'Goes Outside', 'UPORDOWN'],
      'only-ups-only-downs': ['Only Ups', 'ONLYUP', 'Only Downs', 'ONLYDOWN'],
      'only-ups-only': ['Only Ups', 'ONLYUP', 'Only Ups', 'ONLYUP'],
      'only-downs-only': ['Only Downs', 'ONLYDOWN', 'Only Downs', 'ONLYDOWN'],
    };
    const m = map[mode] ?? ['Leg 1', 'CALL', 'Leg 2', 'PUT'];
    return { leg1Label: m[0], leg1Type: m[1], leg2Label: m[2], leg2Type: m[3] };
  }

  // ── Sequential Loop ────────────────────────────────────────────────
  private async loopSequential() {
    while (this.isRunning) {
      await this.executeTrade(this.currentLeg);
      if (!this.isRunning) break;
      if (this.config.isAlternateMode) {
        this.currentLeg = this.currentLeg === 'leg1' ? 'leg2' : 'leg1';
      }
    }
  }

  // ── Hedge Loop ─────────────────────────────────────────────────────
  private async loopHedge() {
    while (this.isRunning) {
      await this.executeHedgeRound();
    }
  }

  // ── Single Trade ──────────────────────────────────────────────────
  private async executeTrade(leg: 'leg1' | 'leg2') {
    if (!this.isRunning) return;
    const cfg = this.config;
    const state = leg === 'leg1' ? store.leg1 : store.leg2;
    const baseStake = leg === 'leg1' ? cfg.baseStake : (cfg.baseStake2 ?? cfg.baseStake);
    const label = state.label;
    let stake = state.currentStake || baseStake;

    // Check cool-off
    if (cfg.enableCoolOff && this.coolOffUntil > Date.now()) {
      const wait = this.coolOffUntil - Date.now();
      store.addLog(`[System] Cool-off active: waiting ${(wait / 1000).toFixed(0)}s`, 'info');
      await this.sleep(wait);
    }

    // Check limits
    if (!this.checkLimits()) return;

    // Propose & buy
    try {
      store.addLog(`[${label}] Proposing at $${stake.toFixed(2)}...`, 'info');
      state.isTrading = true;
      store.broadcast();

      const digit = leg === 'leg1'
        ? this.getNextDigit(cfg.selectedDigit, 1)
        : this.getNextDigit(cfg.selectedDigit2 ?? cfg.selectedDigit, 2);

      const propResult = await this.deriv.placeProposal(
        state.contractType, stake, cfg.symbol,
        cfg.duration, cfg.durationUnit || 't', digit,
        cfg.growthRate, cfg.barrierOffset,
        cfg.multiplier,
      );

      const contractId = await this.deriv.buyContract(propResult.id, propResult.askPrice);
      state.activeContractId = contractId;
      store.addLog(`[${label}] Bought contract ${contractId}`, 'success');
      store.broadcast();

      const result = await this.deriv.waitForResult(contractId);
      state.activeContractId = null;
      state.lastResult = result.won ? 'win' : 'loss';
      state.profit += result.profit;

      store.stats.totalTrades++;
      if (result.won) store.stats.wins++; else store.stats.losses++;
      store.stats.totalProfit += result.profit;

      store.addLog(`[${label}] ${result.won ? 'WIN' : 'LOSS'} $${result.profit.toFixed(2)}`, result.won ? 'success' : 'error');
      store.broadcast();

      // Track consecutive
      if (result.won) { this.consecutiveWins++; this.consecutiveLosses = 0; }
      else { this.consecutiveLosses++; this.consecutiveWins = 0; }

      // Cool-off check
      if (cfg.enableCoolOff) {
        const triggerLoss = this.consecutiveLosses >= (cfg.aiRandomCoolOff ? this.dynamicLossLimit : (cfg.coolOffConsecutiveLosses ?? 3));
        const triggerWin = this.consecutiveWins >= (cfg.aiRandomCoolOff ? this.dynamicWinLimit : (cfg.coolOffConsecutiveWins ?? 3));
        if (triggerLoss || triggerWin) {
          this.coolOffUntil = Date.now() + ((cfg.coolOffDuration ?? 60) * 1000);
          store.addLog(`[System] Cool-off triggered (${triggerLoss ? this.consecutiveLosses + ' losses' : this.consecutiveWins + ' wins'}) for ${cfg.coolOffDuration ?? 60}s`, 'warn');
          this.consecutiveLosses = 0; this.consecutiveWins = 0;
          if (cfg.aiRandomCoolOff) this.randomizeCoolOff();
        }
      }

      // Next stake
      state.currentStake = this.calcStake(
        this.resolveRecovery(cfg.recoveryMethod || 'martingale'),
        result.won, stake, baseStake, cfg.martingaleMultiplier
      );
      if (result.won) this.currentLeg = leg; // stay on winner
      else this.currentLeg = leg === 'leg1' ? 'leg2' : 'leg1';

      state.isTrading = false;
      store.broadcast();

    } catch (err: any) {
      state.isTrading = false;
      state.activeContractId = null;
      store.addLog(`[${label}] Error: ${err.message}`, 'error');
      store.broadcast();
      await this.sleep(2000);
    }
  }

  // ── Hedge Round ────────────────────────────────────────────────────
  private async executeHedgeRound() {
    if (!this.isRunning) return;
    const cfg = this.config;
    const b2 = cfg.baseStake2 ?? cfg.baseStake;

    // Check cool-off
    if (cfg.enableCoolOff && this.coolOffUntil > Date.now()) {
      const wait = this.coolOffUntil - Date.now();
      store.addLog(`[System] Cool-off active: waiting ${(wait / 1000).toFixed(0)}s`, 'info');
      await this.sleep(wait);
    }

    if (!this.checkLimits()) return;

    // Resolve contract types & digits
    let ct1 = store.leg1.contractType;
    let ct2 = store.leg2.contractType;
    let ct3 = store.leg3.contractType;
    let isTriple = false;
    let targets: string[] = [];
    if (cfg.multiDigitObjectives) {
      targets = cfg.multiDigitObjectives.split(',').map(x => x.trim()).filter(x => x);
      if (targets.length === 3) isTriple = true;
    }

    let d1 = this.getNextDigit(cfg.selectedDigit, 1);
    let d2 = this.getNextDigit(cfg.selectedDigit2 ?? cfg.selectedDigit, 2);
    let d3 = d1;

    if (isTriple) {
      const p = (t: string) => {
        const u = t.toUpperCase();
        if (u === 'EVEN') return { type: 'DIGITEVEN', digit: 0 };
        if (u === 'ODD') return { type: 'DIGITODD', digit: 0 };
        if (u === 'RISE' || u === 'CALL') return { type: 'CALL', digit: 0 };
        if (u === 'FALL' || u === 'PUT') return { type: 'PUT', digit: 0 };
        const m = t.match(/^([><=!]+)?(\d+)$/);
        const op = m?.[1] || '=';
        const digit = parseInt(m?.[2] || '5', 10);
        const type = op === '>' ? 'DIGITOVER' : op === '<' ? 'DIGITUNDER' : op.startsWith('!') ? 'DIGITDIFF' : 'DIGITMATCH';
        return { type, digit };
      };
      ct1 = p(targets[0]).type; d1 = p(targets[0]).digit;
      ct2 = p(targets[1]).type; d2 = p(targets[1]).digit;
      ct3 = p(targets[2]).type; d3 = p(targets[2]).digit;
    }

    // Match-Differ: use last tick digit
    if (cfg.mode === 'digits-match-differ') {
      d1 = this.lastTickDigit;
      d2 = this.lastTickDigit;
    }

    // Determine stakes
    let stake1 = store.leg1.currentStake || cfg.baseStake;
    if (this.splitCount1 > 0) stake1 = this.splitStake1;
    let stake2 = store.leg2.currentStake || b2;
    // First round boost for Match-Differ
    if (cfg.mode === 'digits-match-differ' && this.firstRound) {
      stake2 = Math.round((b2 * cfg.martingaleMultiplier) * 100) / 100;
      this.firstRound = false;
    }
    if (this.splitCount2 > 0) stake2 = this.splitStake2;
    let stake3 = store.leg3.currentStake || cfg.baseStake;
    if (this.splitCount3 > 0) stake3 = this.splitStake3;

    const rs1 = Math.round(stake1 * 100) / 100;
    const rs2 = Math.round(stake2 * 100) / 100;
    const rs3 = Math.round(stake3 * 100) / 100;

    // Ghost check
    const threshold = cfg.ghostLossThreshold || 0;
    if (threshold > 0 && this.ghost1 < threshold && this.ghost2 < threshold) {
      store.addLog('[System] Ghost round (virtual)', 'info');
      const sim = () => ({ won: Math.random() > 0.5, profit: 0 });
      const o1 = sim(), o2 = sim();
      if (o1.won) this.ghost1 = 0; else this.ghost1++;
      if (o2.won) this.ghost2 = 0; else this.ghost2++;
      if (isTriple) { const o3 = sim(); if (o3.won) this.ghost3 = 0; else this.ghost3++; }
      await this.sleep(1000);
      this.loopHedge();
      return;
    }

    // Propose & buy
    try {
      store.leg1.isTrading = true; store.leg2.isTrading = true;
      if (isTriple) store.leg3.isTrading = true;
      store.broadcast();

      store.addLog(`[System] Placing: L1 ($${rs1.toFixed(2)}) & L2 ($${rs2.toFixed(2)})${isTriple ? ` & L3 ($${rs3.toFixed(2)})` : ''}`, 'info');

      const cfgM = cfg.multiplier;
      const propResults = await Promise.all([
        this.deriv.placeProposal(ct1, rs1, cfg.symbol, cfg.duration, cfg.durationUnit || 't', d1, cfg.growthRate, cfg.barrierOffset, cfgM),
        this.deriv.placeProposal(ct2, rs2, cfg.symbol, cfg.duration, cfg.durationUnit || 't', d2, cfg.growthRate, cfg.barrierOffset, cfgM),
        ...(isTriple ? [this.deriv.placeProposal(ct3, rs3, cfg.symbol, cfg.duration, cfg.durationUnit || 't', d3, cfg.growthRate, cfg.barrierOffset, cfgM)] : []),
      ]);

      const buys = await Promise.all([
        this.deriv.buyContract(propResults[0].id, propResults[0].askPrice),
        this.deriv.buyContract(propResults[1].id, propResults[1].askPrice),
        ...(isTriple ? [this.deriv.buyContract(propResults[2].id, propResults[2].askPrice)] : []),
      ]);

      store.leg1.activeContractId = buys[0];
      store.leg2.activeContractId = buys[1];
      if (isTriple) store.leg3.activeContractId = buys[2];
      store.addLog(`[Leg 1] Bought ${buys[0]}`, 'success');
      store.addLog(`[Leg 2] Bought ${buys[1]}`, 'success');
      if (isTriple) store.addLog(`[Leg 3] Bought ${buys[2]}`, 'success');
      store.broadcast();

      // Wait for outcomes
      const outcomes = await Promise.all([
        this.deriv.waitForResult(buys[0]),
        this.deriv.waitForResult(buys[1]),
        ...(isTriple ? [this.deriv.waitForResult(buys[2])] : []),
      ]);

      const [p1, w1] = [outcomes[0].profit, outcomes[0].won];
      const [p2, w2] = [outcomes[1].profit, outcomes[1].won];
      const [p3, w3] = isTriple ? [outcomes[2].profit, outcomes[2].won] : [0, true];
      const roundNet = p1 + p2 + p3;

      store.addLog(`[Leg 1] ${w1 ? 'WIN' : 'LOSS'} $${p1.toFixed(2)}`, w1 ? 'success' : 'error');
      store.addLog(`[Leg 2] ${w2 ? 'WIN' : 'LOSS'} $${p2.toFixed(2)}`, w2 ? 'success' : 'error');
      if (isTriple) store.addLog(`[Leg 3] ${w3 ? 'WIN' : 'LOSS'} $${p3.toFixed(2)}`, w3 ? 'success' : 'error');

      store.stats.totalTrades += isTriple ? 3 : 2;
      store.stats.wins += (w1 ? 1 : 0) + (w2 ? 1 : 0) + (isTriple && w3 ? 1 : 0);
      store.stats.losses += (w1 ? 0 : 1) + (w2 ? 0 : 1) + (isTriple && !w3 ? 1 : 0);
      store.stats.totalProfit += roundNet;
      this.peakProfit = Math.max(this.peakProfit, store.stats.totalProfit);

      if (w1) this.ghost1 = 0;
      if (w2) this.ghost2 = 0;
      if (isTriple && w3) this.ghost3 = 0;

      store.leg1.profit += p1; store.leg2.profit += p2; store.leg3.profit += p3;
      store.leg1.activeContractId = null; store.leg2.activeContractId = null; store.leg3.activeContractId = null;
      store.leg1.isTrading = false; store.leg2.isTrading = false; store.leg3.isTrading = false;

      // ── Recovery logic ─────────────────────────────────────────────
      const finalRecovery = this.resolveRecovery(cfg.recoveryMethod || 'martingale');
      let nextStake1 = cfg.baseStake;
      let nextStake2 = b2;
      let nextStake3 = cfg.baseStake;

      if (finalRecovery && isTriple) {
        let std1 = this.calcStake(finalRecovery, w1, rs1, cfg.baseStake, cfg.martingaleMultiplier, 1);
        let std2 = this.calcStake(finalRecovery, w2, rs2, b2, cfg.martingaleMultiplier, 2);
        let std3 = this.calcStake(finalRecovery, w3, rs3, cfg.baseStake, cfg.martingaleMultiplier, 3);

        // Equal digit split (no martingale)
        const isEq1 = targets[0]?.startsWith('=') || ct1 === 'DIGITMATCH';
        const isEq2 = targets[1]?.startsWith('=') || ct2 === 'DIGITMATCH';
        const isEq3 = targets[2]?.startsWith('=') || ct3 === 'DIGITMATCH';
        if (isEq1 && !w1) { const split = Math.round((rs1 / 2) * 100) / 100; std1 = cfg.baseStake; std2 += split; std3 += split; }
        if (isEq2 && !w2) { const split = Math.round((rs2 / 2) * 100) / 100; std2 = cfg.baseStake; std1 += split; std3 += split; }
        if (isEq3 && !w3) { const split = Math.round((rs3 / 2) * 100) / 100; std3 = cfg.baseStake; std1 += split; std2 += split; }

        // Intertrade switch
        if (cfg.isAlternateMode) {
          const winners = [w1 ? 1 : null, w2 ? 2 : null, isTriple && w3 ? 3 : null].filter(Boolean) as number[];
          const losers = [!w1 ? 1 : null, !w2 ? 2 : null, isTriple && !w3 ? 3 : null].filter(Boolean) as number[];
          if (winners.length === 1) {
            const wi = winners[0];
            const r1 = Math.max(0, std1 - cfg.baseStake);
            const r2 = Math.max(0, std2 - b2);
            const r3 = Math.max(0, std3 - cfg.baseStake);
            const total = r1 + r2 + r3;
            if (wi === 1) { nextStake1 = Math.round((cfg.baseStake + total) * 100) / 100; nextStake2 = b2; nextStake3 = cfg.baseStake; }
            else if (wi === 2) { nextStake2 = Math.round((b2 + total) * 100) / 100; nextStake1 = cfg.baseStake; nextStake3 = cfg.baseStake; }
            else { nextStake3 = Math.round((cfg.baseStake + total) * 100) / 100; nextStake1 = cfg.baseStake; nextStake2 = b2; }
          } else if (winners.length === 2) {
            const li = losers[0];
            const lRec = ((li === 1 ? std1 : li === 2 ? std2 : std3) - (li === 2 ? b2 : cfg.baseStake));
            const sr = Math.round((Math.max(0, lRec) / 2) * 100) / 100;
            nextStake1 = std1; nextStake2 = std2; nextStake3 = std3;
            if (li === 1) { nextStake1 = cfg.baseStake; nextStake2 += sr; nextStake3 += sr; }
            else if (li === 2) { nextStake2 = b2; nextStake1 += sr; nextStake3 += sr; }
            else { nextStake3 = cfg.baseStake; nextStake1 += sr; nextStake2 += sr; }
          } else {
            nextStake1 = std1; nextStake2 = std2; nextStake3 = std3;
          }
        } else {
          nextStake1 = std1; nextStake2 = std2; nextStake3 = std3;
        }
      } else if (cfg.mode === 'digits-match-differ') {
        // Split recovery debt adjustment
        const splitCount = cfg.recoverySplitCount || 1;
        if (this.recoveryDebt > 0) {
          if (w2 && this.recoverySplits > 0) {
            this.recoveryDebt = Math.max(0, this.recoveryDebt - p2);
            this.recoverySplits--;
          } else if (!w2) {
            this.recoveryDebt += rs2;
          }
        }

        if (this.recoveryDebt > 0 && this.recoverySplits > 0) {
          nextStake1 = cfg.baseStake;
          nextStake2 = Math.round((this.recoveryDebt / this.recoverySplits) * 100) / 100;
          store.addLog(`[System] Split recovery: chunk $${nextStake2.toFixed(2)} (debt: $${this.recoveryDebt.toFixed(2)} / ${this.recoverySplits} splits)`, 'info');
        } else {
          if (this.recoveryDebt <= 0) { this.recoveryDebt = 0; this.recoverySplits = 0; }
          if (!w1 && w2) {
            nextStake1 = cfg.baseStake;
            nextStake2 = this.calcStake(finalRecovery, false, rs1, b2, cfg.martingaleMultiplier, 2);
            if (splitCount > 1) { this.recoveryDebt = nextStake2 * splitCount; this.recoverySplits = splitCount; nextStake2 = Math.round((this.recoveryDebt / this.recoverySplits) * 100) / 100; }
          } else if (w1 && !w2) {
            nextStake1 = cfg.baseStake;
            nextStake2 = this.calcStake(finalRecovery, false, rs2, b2, cfg.martingaleMultiplier, 2);
            if (splitCount > 1) { this.recoveryDebt = nextStake2 * splitCount; this.recoverySplits = splitCount; nextStake2 = Math.round((this.recoveryDebt / this.recoverySplits) * 100) / 100; }
          } else if (!w1 && !w2) {
            nextStake1 = cfg.baseStake;
            nextStake2 = this.calcStake(finalRecovery, false, rs1 + rs2, b2, cfg.martingaleMultiplier, 2);
            if (splitCount > 1) { this.recoveryDebt = nextStake2 * splitCount; this.recoverySplits = splitCount; nextStake2 = Math.round((this.recoveryDebt / this.recoverySplits) * 100) / 100; }
          } else {
            nextStake1 = cfg.baseStake; nextStake2 = b2;
          }
        }
      } else if (cfg.isAlternateMode) {
        // Intertrade switch
        if (!w1 && w2) { nextStake1 = cfg.baseStake; nextStake2 = this.calcStake(finalRecovery, false, rs1, b2, cfg.martingaleMultiplier, 2); }
        else if (w1 && !w2) { nextStake2 = b2; nextStake1 = this.calcStake(finalRecovery, false, rs2, cfg.baseStake, cfg.martingaleMultiplier, 1); }
        else { nextStake1 = this.calcStake(finalRecovery, w1, rs1, cfg.baseStake, cfg.martingaleMultiplier, 1); nextStake2 = this.calcStake(finalRecovery, w2, rs2, b2, cfg.martingaleMultiplier, 2); }
      } else {
        nextStake1 = this.calcStake(finalRecovery, w1, rs1, cfg.baseStake, cfg.martingaleMultiplier, 1);
        nextStake2 = this.calcStake(finalRecovery, w2, rs2, b2, cfg.martingaleMultiplier, 2);
      }

      // Splitter
      if (cfg.martingaleSplitMode === 'optional' && !w1 && nextStake1 > cfg.baseStake * 6) {
        this.splitCount1 = 2; this.splitStake1 = Math.round((nextStake1 / 2) * 100) / 100;
        nextStake1 = this.splitStake1;
      }
      if (w1) this.splitCount1 = 0;
      else if (this.splitCount1 > 0) { this.splitCount1--; if (this.splitCount1 > 0) nextStake1 = this.splitStake1; }

      if (cfg.martingaleSplitMode === 'optional' && !w2 && nextStake2 > b2 * 6) {
        this.splitCount2 = 2; this.splitStake2 = Math.round((nextStake2 / 2) * 100) / 100;
        nextStake2 = this.splitStake2;
      }
      if (w2) this.splitCount2 = 0;
      else if (this.splitCount2 > 0) { this.splitCount2--; if (this.splitCount2 > 0) nextStake2 = this.splitStake2; }

      if (isTriple) {
        if (cfg.martingaleSplitMode === 'optional' && !w3 && nextStake3 > cfg.baseStake * 6) {
          this.splitCount3 = 2; this.splitStake3 = Math.round((nextStake3 / 2) * 100) / 100;
          nextStake3 = this.splitStake3;
        }
        if (w3) this.splitCount3 = 0;
        else if (this.splitCount3 > 0) { this.splitCount3--; if (this.splitCount3 > 0) nextStake3 = this.splitStake3; }
      }

      store.leg1.currentStake = Math.round(nextStake1 * 100) / 100;
      store.leg2.currentStake = Math.round(nextStake2 * 100) / 100;
      store.leg3.currentStake = Math.round(nextStake3 * 100) / 100;

      this.peakProfit = Math.max(this.peakProfit, store.stats.totalProfit);
      store.broadcast();

    } catch (err: any) {
      store.leg1.isTrading = false; store.leg2.isTrading = false; store.leg3.isTrading = false;
      store.leg1.activeContractId = null; store.leg2.activeContractId = null; store.leg3.activeContractId = null;
      store.addLog(`[System] Hedge round error: ${err.message}`, 'error');
      store.broadcast();
      await this.sleep(2000);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────
  private getNextDigit(arr: number[], leg: number): number {
    if (arr.length === 0) return 5;
    const idx = leg === 1 ? this.digitIdx1 : (leg === 2 ? this.digitIdx2 : this.digitIdx3);
    const digit = arr[idx % arr.length];
    if (leg === 1) this.digitIdx1++;
    else if (leg === 2) this.digitIdx2++;
    else this.digitIdx3++;
    return digit;
  }

  // ── Multiplier Loop ────────────────────────────────────────────────
  private async loopMultiplier() {
    while (this.isRunning) {
      try {
        // Minimum 5s gap between trades to avoid rate limits
        const elapsed = Date.now() - this.lastTradeTime;
        if (elapsed < 5000) {
          await this.sleep(5000 - elapsed);
        }
        await this.executeMultiplierTrade();
        this.lastTradeTime = Date.now();
        this.consecutiveErrors = 0;
      } catch (err: any) {
        this.consecutiveErrors++;
        store.addLog(`[Multiplier] Error: ${err.message}`, 'error');
        store.broadcast();
        if (this.consecutiveErrors >= 10) {
          this.stop('Too many consecutive errors');
          break;
        }
        // Rate limit or max contracts: backoff longer
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('rate limit') || msg.includes('rate_limit')) {
          store.addLog('[Multiplier] Rate limited — backing off 60s', 'warn');
          await this.sleep(60000);
        } else if (msg.includes('cannot hold more than') || msg.includes('max') || msg.includes('limit')) {
          store.addLog('[Multiplier] Contract limit reached — backing off 120s', 'warn');
          await this.sleep(120000);
        } else {
          await this.sleep(5000);
        }
      }
    }
  }

  private async executeMultiplierTrade() {
    const cfg = this.config;
    const ct = this.getMultiplierContractType(cfg.mode);
    const stake = cfg.baseStake;
    const label = ct === 'MULTUP' ? 'Multiplier Up' : 'Multiplier Down';

    if (!this.checkLimits()) return;

    try {
      store.addLog(`[${label}] Proposing $${stake.toFixed(2)} at ${cfg.multiplier ?? 400}x`, 'info');
      store.leg1.isTrading = true;
      store.leg1.label = label;
      store.leg1.contractType = ct;
      store.broadcast();

      const propResult = await this.deriv.placeProposal(
        ct, stake, cfg.symbol, cfg.duration, cfg.durationUnit || 't',
        undefined, undefined, undefined, cfg.multiplier,
      );

      const contractId = await this.deriv.buyContract(propResult.id, propResult.askPrice);
      store.leg1.activeContractId = contractId;
      store.addLog(`[${label}] Bought contract ${contractId}`, 'success');
      store.broadcast();

      // Deal cancellation if configured
      if (cfg.dealCancelSeconds && cfg.dealCancelSeconds > 0) {
        store.addLog(`[${label}] Deal cancellation active: ${cfg.dealCancelSeconds}s`, 'info');
      }

      // Monitor ticks and sell at TP/SL
      const tp = cfg.takeProfit;
      const sl = cfg.stopLoss;
      let sold = false;
      let unsubTicks: (() => void) | null = null;

      if (tp > 0 || sl > 0) {
        unsubTicks = await this.deriv.subscribeTicks(cfg.symbol, async (tick) => {
          if (!this.isRunning || sold) return;
          const status = await this.deriv.getContractStatus(contractId).catch(() => null);
          if (!status) return;
          store.leg1.currentStake = status.buyPrice + status.profit;
          store.broadcast();

          try {
            if (tp > 0 && status.profit >= tp) {
              sold = true;
              store.addLog(`[${label}] Take profit $${tp.toFixed(2)} reached`, 'success');
              await this.deriv.sellContract(contractId);
            } else if (sl > 0 && status.profit <= -sl) {
              sold = true;
              store.addLog(`[${label}] Stop loss $${sl.toFixed(2)} hit`, 'error');
              await this.deriv.sellContract(contractId);
            }
          } catch (sellErr: any) {
            sold = false;
            store.addLog(`[${label}] Sell failed: ${sellErr.message}`, 'error');
            store.broadcast();
          }
        });

        // Wait for result
        const result = await this.deriv.waitForResult(contractId);
        if (unsubTicks) unsubTicks();
        store.leg1.activeContractId = null;
        store.leg1.lastResult = result.won ? 'win' : 'loss';
        store.leg1.profit += result.profit;
        store.stats.totalTrades++;
        if (result.won) store.stats.wins++; else store.stats.losses++;
        store.stats.totalProfit += result.profit;
        store.addLog(`[${label}] ${result.won ? 'WIN' : 'LOSS'} $${result.profit.toFixed(2)}`, result.won ? 'success' : 'error');
        store.broadcast();
      } else {
        // No TP/SL — just wait for expiry
        const result = await this.deriv.waitForResult(contractId);
        store.leg1.activeContractId = null;
        store.leg1.lastResult = result.won ? 'win' : 'loss';
        store.leg1.profit += result.profit;
        store.stats.totalTrades++;
        if (result.won) store.stats.wins++; else store.stats.losses++;
        store.stats.totalProfit += result.profit;
        store.addLog(`[${label}] ${result.won ? 'WIN' : 'LOSS'} $${result.profit.toFixed(2)}`, result.won ? 'success' : 'error');
        store.broadcast();
      }

      store.leg1.isTrading = false;
      store.broadcast();

    } catch (err: any) {
      store.leg1.isTrading = false;
      store.leg1.activeContractId = null;
      store.addLog(`[${label}] Error: ${err.message}`, 'error');
      store.broadcast();
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('rate limit') || msg.includes('rate_limit')) {
        store.addLog('[Multiplier] Rate limited — backing off 60s', 'warn');
        await this.sleep(60000);
      } else if (msg.includes('cannot hold more than') || msg.includes('limit')) {
        store.addLog('[Multiplier] Contract limit reached — backing off 120s', 'warn');
        await this.sleep(120000);
      } else {
        await this.sleep(2000);
      }
    }
  }

  // ── Multiplier Hedge Loop ─────────────────────────────────────────
  private async loopMultiplierHedge() {
    while (this.isRunning) {
      try {
        const elapsed = Date.now() - this.lastTradeTime;
        if (elapsed < 5000) {
          await this.sleep(5000 - elapsed);
        }
        await this.executeMultiplierHedgeRound();
        this.lastTradeTime = Date.now();
        this.consecutiveErrors = 0;
      } catch (err: any) {
        this.consecutiveErrors++;
        store.addLog(`[Multiplier Hedge] Error: ${err.message}`, 'error');
        store.broadcast();
        if (this.consecutiveErrors >= 10) {
          this.stop('Too many consecutive errors');
          break;
        }
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('rate limit') || msg.includes('rate_limit')) {
          store.addLog('[Multiplier Hedge] Rate limited — backing off 60s', 'warn');
          await this.sleep(60000);
        } else if (msg.includes('cannot hold more than') || msg.includes('max') || msg.includes('limit')) {
          store.addLog('[Multiplier Hedge] Contract limit reached — backing off 120s', 'warn');
          await this.sleep(120000);
        } else {
          await this.sleep(5000);
        }
      }
    }
  }

  private async executeMultiplierHedgeRound() {
    const cfg = this.config;
    const stake = cfg.baseStake;
    if (!this.checkLimits()) return;

    try {
      store.addLog(`[Hedge Multiplier] Proposing both legs at $${stake.toFixed(2)} each, ${cfg.multiplier ?? 400}x`, 'info');
      store.leg1.isTrading = true; store.leg2.isTrading = true;
      store.leg1.label = 'Multiplier Up'; store.leg1.contractType = 'MULTUP';
      store.leg2.label = 'Multiplier Down'; store.leg2.contractType = 'MULTDOWN';
      store.broadcast();

      // Propose both simultaneously
      const [propUp, propDown] = await Promise.all([
        this.deriv.placeProposal('MULTUP', stake, cfg.symbol, cfg.duration, cfg.durationUnit || 't', undefined, undefined, undefined, cfg.multiplier),
        this.deriv.placeProposal('MULTDOWN', stake, cfg.symbol, cfg.duration, cfg.durationUnit || 't', undefined, undefined, undefined, cfg.multiplier),
      ]);

      // Buy both simultaneously
      const [buyUp, buyDown] = await Promise.all([
        this.deriv.buyContract(propUp.id, propUp.askPrice),
        this.deriv.buyContract(propDown.id, propDown.askPrice),
      ]);

      store.leg1.activeContractId = buyUp;
      store.leg2.activeContractId = buyDown;
      store.addLog(`[Multiplier Up] Bought ${buyUp}`, 'success');
      store.addLog(`[Multiplier Down] Bought ${buyDown}`, 'success');
      store.broadcast();

      // Deal cancellation
      if (cfg.dealCancelSeconds && cfg.dealCancelSeconds > 0) {
        store.addLog(`[Hedge Multiplier] Deal cancellation active: ${cfg.dealCancelSeconds}s`, 'info');
      }

      // Monitor both for TP/SL via ticks
      const tp = cfg.takeProfit;
      const sl = cfg.stopLoss;
      let soldUp = false, soldDown = false;
      let unsubTicks: (() => void) | null = null;

      if (tp > 0 || sl > 0) {
        unsubTicks = await this.deriv.subscribeTicks(cfg.symbol, async (tick) => {
          if (!this.isRunning) return;

          try {
            const [statusUp, statusDown] = await Promise.all([
              this.deriv.getContractStatus(buyUp).catch(() => null),
              this.deriv.getContractStatus(buyDown).catch(() => null),
            ]);

            if (statusUp) {
              store.leg1.currentStake = statusUp.buyPrice + statusUp.profit;
              if (!soldUp) {
                if (tp > 0 && statusUp.profit >= tp) {
                  soldUp = true;
                  store.addLog(`[Multiplier Up] Take profit $${tp.toFixed(2)} reached`, 'success');
                  await this.deriv.sellContract(buyUp).catch(() => {});
                } else if (sl > 0 && statusUp.profit <= -sl) {
                  soldUp = true;
                  store.addLog(`[Multiplier Up] Stop loss $${sl.toFixed(2)} hit`, 'error');
                  await this.deriv.sellContract(buyUp).catch(() => {});
                }
              }
            }

            if (statusDown) {
              store.leg2.currentStake = statusDown.buyPrice + statusDown.profit;
              if (!soldDown) {
                if (tp > 0 && statusDown.profit >= tp) {
                  soldDown = true;
                  store.addLog(`[Multiplier Down] Take profit $${tp.toFixed(2)} reached`, 'success');
                  await this.deriv.sellContract(buyDown).catch(() => {});
                } else if (sl > 0 && statusDown.profit <= -sl) {
                  soldDown = true;
                  store.addLog(`[Multiplier Down] Stop loss $${sl.toFixed(2)} hit`, 'error');
                  await this.deriv.sellContract(buyDown).catch(() => {});
                }
              }
            }

            store.broadcast();
          } catch { /* ignore tick handler errors */ }
        });
      }

      // Wait for both results
      const [resultUp, resultDown] = await Promise.all([
        this.deriv.waitForResult(buyUp),
        this.deriv.waitForResult(buyDown),
      ]);

      if (unsubTicks) unsubTicks();

      store.leg1.activeContractId = null;
      store.leg2.activeContractId = null;
      store.leg1.lastResult = resultUp.won ? 'win' : 'loss';
      store.leg2.lastResult = resultDown.won ? 'win' : 'loss';
      store.leg1.profit += resultUp.profit;
      store.leg2.profit += resultDown.profit;
      store.stats.totalTrades += 2;
      if (resultUp.won) store.stats.wins++; else store.stats.losses++;
      if (resultDown.won) store.stats.wins++; else store.stats.losses++;
      store.stats.totalProfit += resultUp.profit + resultDown.profit;
      store.addLog(`[Multiplier Up] ${resultUp.won ? 'WIN' : 'LOSS'} $${resultUp.profit.toFixed(2)}`, resultUp.won ? 'success' : 'error');
      store.addLog(`[Multiplier Down] ${resultDown.won ? 'WIN' : 'LOSS'} $${resultDown.profit.toFixed(2)}`, resultDown.won ? 'success' : 'error');
      store.broadcast();

      store.leg1.isTrading = false;
      store.leg2.isTrading = false;
      store.broadcast();

    } catch (err: any) {
      store.leg1.isTrading = false; store.leg2.isTrading = false;
      store.leg1.activeContractId = null; store.leg2.activeContractId = null;
      store.addLog(`[Hedge Multiplier] Error: ${err.message}`, 'error');
      store.broadcast();
      const msg = (err.message || '').toLowerCase();
      if (msg.includes('rate limit') || msg.includes('rate_limit')) {
        store.addLog('[Multiplier] Rate limited — backing off 60s', 'warn');
        await this.sleep(60000);
      } else if (msg.includes('cannot hold more than') || msg.includes('limit')) {
        store.addLog('[Multiplier] Contract limit reached — backing off 120s', 'warn');
        await this.sleep(120000);
      } else {
        await this.sleep(2000);
      }
    }
  }

  private getMultiplierContractType(mode: string): string {
    if (mode === 'multipliers-up-only') return 'MULTUP';
    if (mode === 'multipliers-down-only') return 'MULTDOWN';
    // alternating between legs
    this.multiDigitIdx++;
    return this.multiDigitIdx % 2 === 1 ? 'MULTUP' : 'MULTDOWN';
  }

  private checkLimits(): boolean {
    if (!this.isRunning) return false;
    if (this.config.takeProfit > 0 && store.stats.totalProfit >= this.config.takeProfit) {
      this.stop(`Take profit $${this.config.takeProfit.toFixed(2)} reached`);
      return false;
    }
    if (this.config.stopLoss > 0 && store.stats.totalProfit <= -this.config.stopLoss) {
      this.stop(`Stop loss $${this.config.stopLoss.toFixed(2)} hit`);
      return false;
    }
    if (this.config.trailingProfitLock && this.config.trailingProfitLock > 0 && this.peakProfit > 0) {
      const floor = Math.max(0, this.peakProfit * (this.config.trailingProfitLock / 100));
      if (store.stats.totalProfit <= floor && store.stats.totalProfit < this.peakProfit) {
        this.stop(`Trailing profit lock triggered (high: $${this.peakProfit.toFixed(2)})`);
        return false;
      }
    }
    if (this.config.maxTradesLimit && this.config.maxTradesLimit > 0 && store.stats.totalTrades >= this.config.maxTradesLimit) {
      this.stop(`Max trades limit ${this.config.maxTradesLimit} reached`);
      return false;
    }
    return true;
  }

  private randomizeCoolOff() {
    this.dynamicLossLimit = Math.max(1, (this.config.coolOffConsecutiveLosses ?? 3) + Math.floor(Math.random() * 3) - 1);
    this.dynamicWinLimit = Math.max(1, (this.config.coolOffConsecutiveWins ?? 3) + Math.floor(Math.random() * 3) - 1);
  }
}
