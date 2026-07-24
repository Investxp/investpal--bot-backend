import WebSocket from 'ws';

const DERIV_WS_URL = 'wss://ws.deriv.com/websockets/v3';

export class DerivClient {
  private ws: WebSocket | null = null;
  private pending: Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = new Map();
  private msgId = 0;
  private appId: string;
  private token: string;
  private tickHandlers: Set<(tick: { quote: number; epoch: number }) => void> = new Set();
  private proposaHandlers: Set<(proposal: any) => void> = new Set();
  private contractHandlers: Map<number, (result: { won: boolean; profit: number }) => void> = new Map();

  constructor(appId: string, token: string) {
    this.appId = appId;
    this.token = token;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${DERIV_WS_URL}?app_id=${this.appId}`);
      this.ws.on('open', () => {
        this.authorize().then(resolve).catch(reject);
      });
      this.ws.on('message', (raw) => this.handleMessage(raw.toString()));
      this.ws.on('close', () => this.handleClose());
      this.ws.on('error', (err) => reject(err));
    });
  }

  async verifyToken(): Promise<{ valid: boolean; error?: string; loginid?: string }> {
    const ws = new WebSocket(`${DERIV_WS_URL}?app_id=${this.appId}`);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ws.close();
        resolve({ valid: false, error: 'Connection timeout' });
      }, 10000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ authorize: this.token, req_id: 1 }));
      });
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.req_id === 1) {
            clearTimeout(timer);
            ws.close();
            if (msg.error) {
              const isExpired = /expired|invalid|token/i.test(msg.error.message);
              resolve({ valid: false, error: isExpired ? 'TOKEN_EXPIRED' : msg.error.message });
            } else {
              resolve({ valid: true, loginid: msg.authorize?.loginid });
            }
          }
        } catch { /* ignore */ }
      });
      ws.on('error', () => {
        clearTimeout(timer);
        resolve({ valid: false, error: 'WebSocket error' });
      });
    });
  }

  private async authorize(): Promise<void> {
    await this.send({ authorize: this.token });
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
      if (msg.msg_type === 'contract') {
        const handler = this.contractHandlers.get(Number(msg.contract.contract_id));
        if (handler) {
          const status = msg.contract.status;
          const won = ['won', 'profit', 'sold'].includes(status) && (msg.contract.profit ?? 0) > 0;
          handler({ won, profit: msg.contract.profit ?? 0 });
          this.contractHandlers.delete(Number(msg.contract.contract_id));
        }
      }
    } catch { /* ignore parse errors */ }
  }

  private handleClose() {
    this.pending.forEach(({ reject, timer }) => {
      clearTimeout(timer);
      reject(new Error('WebSocket disconnected'));
    });
    this.pending.clear();
    this.ws = null;
  }

  async subscribeTicks(symbol: string, handler: (tick: { quote: number; epoch: number }) => void) {
    this.tickHandlers.add(handler);
    await this.send({ ticks: symbol, subscribe: 1 });
    return () => {
      this.tickHandlers.delete(handler);
      this.send({ forget_all: 'ticks' }).catch(() => {});
    };
  }

  async getLastDigit(symbol: string): Promise<number> {
    const resp = await this.send({ ticks: symbol, adjust_to_min: 1 });
    const tick = resp.tick ?? resp.history?.ticks?.at?.(-1);
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
    payoffAmount?: number,
  ): Promise<string> {
    const payload: Record<string, any> = {
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      symbol,
    };
    const isMultiplier = ['MULTUP', 'MULTDOWN'].includes(contractType);
    const isVanilla = ['VANILLALONGCALL', 'VANILLALONGPUT'].includes(contractType);

    if (isMultiplier) {
      payload.multiplier = multiplier ?? 10;
    } else if (isVanilla) {
      if (payoffAmount) payload.payoff_amount = payoffAmount;
      payload.duration = duration;
      payload.duration_unit = durationUnit;
    } else if (contractType === 'ACCU') {
      payload.growth_rate = growthRate ?? 0.01;
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
    const resp = await this.send(payload);
    if (!resp.proposal?.id) throw new Error('No proposal ID');
    return resp.proposal.id;
  }

  async buyContract(proposalId: string, stake: number): Promise<number> {
    const resp = await this.send({ buy: proposalId, price: stake });
    return resp.buy?.contract_id ?? 0;
  }

  async sellContract(contractId: number, price?: number): Promise<void> {
    const payload: Record<string, any> = { sell: contractId };
    if (price !== undefined) payload.price = price;
    await this.send(payload);
  }

  async cancelContract(contractId: number): Promise<void> {
    await this.send({ cancel: contractId });
  }

  async getContractStatus(contractId: number): Promise<{ status: string; profit: number; buyPrice: number; currentSpot?: number }> {
    const resp = await this.send({ contract_id: contractId });
    const c = resp.contract || {};
    return {
      status: c.status || 'open',
      profit: c.profit ?? 0,
      buyPrice: c.buy_price ?? 0,
      currentSpot: c.current_spot,
    };
  }

  waitForResult(contractId: number): Promise<{ won: boolean; profit: number }> {
    return new Promise((resolve) => {
      this.contractHandlers.set(contractId, resolve);
      this.send({ subscribe: 1, contract_id: contractId }).catch(() => {});
    });
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
