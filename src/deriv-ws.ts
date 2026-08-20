import WebSocket from 'ws';
import https from 'https';

const OTP_API_BASE = 'https://api.derivws.com/trading/v1/options';

export class DerivClient {
  private ws: WebSocket | null = null;
  private pending: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = new Map();
  private msgId = 0;
  private appId: string;
  private token: string;
  private tickHandlers: Set<(tick: { quote: number; epoch: number }) => void> = new Set();
  private proposaHandlers: Set<(proposal: any) => void> = new Set();
  private contractHandlers: Map<number, (result: { won: boolean; profit: number }) => void> = new Map();
  private otpWsUrl: string | null = null;
  private currentAccountId: string | null = null;

  // Reconnection state
  private shouldReconnect = false;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private oauthToken = '';
  private accountIdForReconnect = '';
  private tickSubscriptions: Map<string, Set<(tick: { quote: number; epoch: number }) => void>> = new Map();
  private onStatusChange: ((connected: boolean, reason?: string) => void) | null = null;

  constructor(token: string) {
    this.appId = '33O6s5sRWxywmFZAGbjBf';
    this.token = token;
  }

  get hasOtpUrl(): boolean {
    return !!this.otpWsUrl;
  }

  get accountId(): string | null {
    return this.currentAccountId;
  }

  setStatusHandler(handler: (connected: boolean, reason?: string) => void) {
    this.onStatusChange = handler;
  }

  private callOtpApi(oauthToken: string, accountId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${OTP_API_BASE}/accounts/${accountId}/otp`);
      const postData = '';
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          timeout: 20000,
          headers: {
            'Deriv-App-ID': this.appId,
            'Authorization': `Bearer ${oauthToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              if (json.data?.url) {
                this.currentAccountId = accountId;
                resolve(json.data.url);
              } else {
                reject(new Error(json.errors?.[0]?.message || 'No OTP URL returned'));
              }
            } catch {
              reject(new Error('Invalid OTP API response'));
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('Timed out requesting OTP session')));
      req.write(postData);
      req.end();
    });
  }

  async initialize(oauthToken: string, accountId: string): Promise<void> {
    this.oauthToken = oauthToken;
    this.accountIdForReconnect = accountId;
    const url = await this.callOtpApi(oauthToken, accountId);
    this.otpWsUrl = url;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    await this.connect();
    this.onStatusChange?.(true);
  }

  async connect(): Promise<void> {
    if (!this.otpWsUrl) {
      throw new Error('No OTP WebSocket URL. Call initialize() first.');
    }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.otpWsUrl!);
      let settled = false;

      ws.on('open', () => {
        settled = true;
        this.ws = ws;
        this.reconnectAttempts = 0;
        resolve();
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          ws.close();
        }
      });

      ws.on('close', () => {
        this.ws = null;
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket closed before open'));
        } else {
          this.handleClose('Connection lost');
        }
      });

      ws.on('message', (raw) => this.handleMessage(raw.toString()));
    });
  }

  private send<T = any>(msg: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }
      const id = ++this.msgId;
      const payload = { ...msg, req_id: id };
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`Request ${id} timed out`));
      }, 15000);
      this.pending.set(String(id), { resolve, reject, timer });
      this.ws!.send(JSON.stringify(payload));
    });
  }

  private handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);
      const id = msg.req_id;
      if (id && this.pending.has(String(id))) {
        const { resolve, reject, timer } = this.pending.get(String(id))!;
        clearTimeout(timer);
        this.pending.delete(String(id));
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg);
      }
      if (msg.msg_type === 'tick') {
        this.tickHandlers.forEach(fn => fn({ quote: msg.tick.quote, epoch: msg.tick.epoch }));
      }
      if (msg.msg_type === 'proposal') {
        this.proposaHandlers.forEach(fn => fn(msg));
      }
      const contractMsg = msg.msg_type === 'proposal_open_contract' ? msg : (msg.msg_type === 'contract' ? msg : null);
      if (contractMsg) {
        const contractData = contractMsg.msg_type === 'proposal_open_contract' ? contractMsg.proposal_open_contract : contractMsg.contract;
        const handler = this.contractHandlers.get(Number(contractData.contract_id));
        if (handler) {
          const status = contractData.status;
          const isClosed = ['won', 'profit', 'sold', 'lost'].includes(status);
          if (isClosed) {
            const won = ['won', 'profit', 'sold'].includes(status) && Number(contractData.profit ?? 0) > 0;
            handler({ won, profit: Number(contractData.profit ?? 0) });
            this.contractHandlers.delete(Number(contractData.contract_id));
          }
        }
      }
    } catch { /* ignore parse errors */ }
  }

  private handleClose(reason = 'WebSocket disconnected') {
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error(reason));
    });
    this.pending.clear();
    this.ws = null;

    this.onStatusChange?.(false, reason);

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.shouldReconnect = false;
      this.onStatusChange?.(false, 'Max reconnection attempts reached');
      return;
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(async () => {
      try {
        // OTP WebSocket URLs are temporary — fetch a fresh session before reconnecting
        if (this.oauthToken && this.accountIdForReconnect) {
          try {
            this.otpWsUrl = await this.callOtpApi(this.oauthToken, this.accountIdForReconnect);
          } catch { /* keep the old URL as a last resort */ }
        }
        await this.connect();
        await this.resubscribeTicks();
        this.onStatusChange?.(true);
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async resubscribeTicks() {
    for (const [symbol, handlers] of this.tickSubscriptions) {
      if (handlers.size > 0) {
        try {
          await this.send({ ticks: symbol, subscribe: 1 });
        } catch { /* symbol may no longer be valid */ }
      }
    }
  }

  async subscribeTicks(symbol: string, handler: (tick: { quote: number; epoch: number }) => void) {
    this.tickHandlers.add(handler);
    // Track per-symbol for reconnect re-subscription
    if (!this.tickSubscriptions.has(symbol)) {
      this.tickSubscriptions.set(symbol, new Set());
    }
    this.tickSubscriptions.get(symbol)!.add(handler);
    await this.send({ ticks: symbol, subscribe: 1 }).catch(() => {});
    return () => {
      this.tickHandlers.delete(handler);
      const subs = this.tickSubscriptions.get(symbol);
      if (subs) {
        subs.delete(handler);
        if (subs.size === 0) {
          this.tickSubscriptions.delete(symbol);
        }
      }
      this.send({ forget_all: 'ticks' }).catch(() => {});
    };
  }

  async getLastDigit(symbol: string): Promise<number> {
    const resp = await this.send({ ticks: symbol });
    const tick = resp.tick;
    if (!tick) return 5;
    const quoteStr = tick.quote.toString();
    const dotIdx = quoteStr.indexOf('.');
    const pipSize = dotIdx === -1 ? 0 : quoteStr.length - dotIdx - 1;
    return pipSize > 0 ? parseInt(quoteStr.slice(-1), 10) : Math.floor(Math.abs(tick.quote) % 10);
  }

  async placeProposal(
    contractType: string,
    stake: number,
    symbol: string,
    duration: number,
    durationUnit: string,
    digit?: number,
    growthRate?: number,
    barrierOffset?: string,
    multiplier?: number,
    selectedTick?: number,
  ): Promise<{ id: string; askPrice: number }> {
    const isAccu = contractType === 'ACCU';
    const isMultiplier = ['MULTUP', 'MULTDOWN'].includes(contractType);
    const isTick = ['TICKHIGH', 'TICKLOW'].includes(contractType);
    const isVanilla = ['VANILLALONGCALL', 'VANILLALONGPUT'].includes(contractType);
    const minStake = isAccu ? 1.00 : isMultiplier ? 1.00 : isVanilla ? 0.40 : 0.35;
    if (stake < minStake) {
      stake = minStake;
    }
    const payload: Record<string, any> = {
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      underlying_symbol: symbol,
    };

    if (isTick) {
      payload.selected_tick = selectedTick ?? 1;
      payload.duration = 5;
      payload.duration_unit = 't';
    } else if (isMultiplier) {
      payload.multiplier = multiplier ?? 400;
    } else if (isVanilla) {
      payload.duration = Math.max(duration, 86400);
      payload.duration_unit = 's';
      const raw = barrierOffset || '+0.00';
      if (!raw.startsWith('+') && !raw.startsWith('-')) {
        payload.barrier = contractType === 'VANILLALONGCALL' ? '+' + raw : '-' + raw;
      } else {
        payload.barrier = raw;
      }
      // Vanilla barriers are dynamic — if invalid, parse available barriers and retry
      try {
        const vanillaResp = await this.send(payload);
        if (!vanillaResp.proposal?.id) throw new Error(`No proposal ID for ${contractType} on ${symbol}. Payload: ${JSON.stringify(payload)}`);
        return { id: vanillaResp.proposal.id, askPrice: Number(vanillaResp.proposal.ask_price ?? stake) };
      } catch (vanillaErr: any) {
        const errMsg = vanillaErr.message || '';
        const match = errMsg.match(/Barriers available are (.+)\./);
        if (match) {
          const barriers: string[] = match[1].split(',').map((b: string) => b.trim());
          const requested = parseFloat(payload.barrier);
          const closest = barriers.reduce((prev: string, curr: string) => {
            const diff = Math.abs(parseFloat(curr) - requested);
            return diff < Math.abs(parseFloat(prev) - requested) ? curr : prev;
          });
          payload.barrier = closest;
          const retryResp = await this.send(payload);
          if (!retryResp.proposal?.id) throw new Error(`No proposal ID for ${contractType} on ${symbol}. Payload: ${JSON.stringify(payload)}`);
          return { id: retryResp.proposal.id, askPrice: Number(retryResp.proposal.ask_price ?? stake) };
        }
        throw vanillaErr;
      }
    } else if (contractType === 'ACCU') {
      payload.growth_rate = Math.max(0.01, Math.min(0.05, growthRate ?? 0.01));
    } else if (['TURBOSLONG', 'TURBOSSHORT'].includes(contractType)) {
      payload.duration = duration;
      payload.duration_unit = durationUnit;
      if (barrierOffset) {
        const raw = barrierOffset;
        payload.barrier = contractType === 'TURBOSLONG'
          ? (raw.startsWith('+') || raw.startsWith('-') ? raw : '+' + raw)
          : (raw.startsWith('+') || raw.startsWith('-') ? raw : '-' + raw);
      }
    } else if (['EXPIRYRANGE', 'EXPIRYMISS', 'RANGE', 'UPORDOWN'].includes(contractType)) {
      payload.duration = duration;
      payload.duration_unit = durationUnit;
      if (barrierOffset) {
        const raw = barrierOffset;
        const isPos = raw.startsWith('+');
        const isNeg = raw.startsWith('-');
        const numVal = parseFloat(raw.replace(/[+\-]/, ''));
        if (!isNaN(numVal) && numVal > 0) {
          payload.barrier = isNeg ? ('-' + numVal.toFixed(2)) : '+0.00';
          payload.barrier2 = isPos ? ('+' + numVal.toFixed(2)) : '+0.00';
        } else {
          payload.barrier = '+0.00';
          payload.barrier2 = '+0.01';
        }
      } else {
        payload.barrier = '+0.00';
        payload.barrier2 = '+0.01';
      }
    } else {
      payload.duration = duration;
      payload.duration_unit = durationUnit;
      const isDigit = ['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(contractType);
      if (isDigit && digit !== undefined) payload.barrier = String(digit);
      const isBarrier = ['HIGHER', 'LOWER', 'ONETOUCH', 'NOTOUCH'].includes(contractType);
      if (isBarrier && barrierOffset) {
        const raw = barrierOffset;
        if (!raw.startsWith('+') && !raw.startsWith('-')) {
          payload.barrier = ['HIGHER', 'ONETOUCH'].includes(contractType) ? '+' + raw : '-' + raw;
        } else {
          payload.barrier = raw;
        }
      }
    }
    let resp: any;
    try {
      resp = await this.send(payload);
    } catch (sendErr: any) {
      throw new Error(`${sendErr.message}. Payload: ${JSON.stringify(payload)}`);
    }
    if (!resp.proposal?.id) {
      const errMsg = resp.error?.message || `No proposal ID for ${contractType} on ${symbol}`;
      throw new Error(`${errMsg}. Payload: ${JSON.stringify(payload)}`);
    }
    return { id: resp.proposal.id, askPrice: Number(resp.proposal.ask_price ?? stake) };
  }

  async buyContract(proposalId: string, askPrice: number): Promise<number> {
    const resp = await this.send({ buy: proposalId, price: askPrice });
    return resp.buy.contract_id;
  }

  async sellContract(contractId: number, price: number = 0): Promise<void> {
    await this.send({ sell: contractId, price });
  }

  async cancelContract(contractId: number): Promise<void> {
    await this.send({ cancel: contractId });
  }

  async getContractStatus(contractId: number): Promise<{ status: string; profit: number; buyPrice: number; currentSpot?: number }> {
    const resp = await this.send({ proposal_open_contract: 1, contract_id: contractId });
    const c = resp.proposal_open_contract || resp.contract || {};
    return {
      status: c.status || 'open',
      profit: Number(c.profit) ?? 0,
      buyPrice: Number(c.buy_price) ?? 0,
      currentSpot: c.current_spot,
    };
  }

  waitForResult(contractId: number): Promise<{ won: boolean; profit: number }> {
    return new Promise((resolve) => {
      this.contractHandlers.set(contractId, resolve);
      this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 }).catch(() => {});

      const pollInterval = setInterval(async () => {
        try {
          const status = await this.getContractStatus(contractId);
            if (['won', 'profit', 'sold', 'lost'].includes(status.status)) {
              clearInterval(pollInterval);
              const won = ['won', 'profit', 'sold'].includes(status.status) && Number(status.profit) > 0;
              const handler = this.contractHandlers.get(contractId);
              if (handler) {
                handler({ won, profit: Number(status.profit) });
              this.contractHandlers.delete(contractId);
            }
          }
        } catch { /* connection may be down, keep polling */ }
      }, 1000);

      setTimeout(() => {
        clearInterval(pollInterval);
        const handler = this.contractHandlers.get(contractId);
        if (handler) {
          handler({ won: true, profit: 0 });
          this.contractHandlers.delete(contractId);
        }
      }, 300_000);
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
