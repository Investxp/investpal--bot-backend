import WebSocket from 'ws';

/**
 * Server-side copy trading client using legacy Deriv v3 WS (PAT-based).
 * Migrated from browser-side WS to backend-managed connection for reliability.
 */
export class CopyClient {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private _connected = false;
  private _accountId: string | null = null;
  private _balance: number | null = null;
  private apiToken = '';

  get connected() { return this._connected; }
  get accountId() { return this._accountId; }
  get balance() { return this._balance; }

  private get appId() {
    return process.env.DERIV_APP_ID || '';
  }

  async connect(apiToken: string): Promise<void> {
    this.apiToken = apiToken;
    const appId = this.appId;
    if (!appId) throw new Error('DERIV_APP_ID not configured');

    const endpoints = [
      `wss://ws.derivws.com/websockets/v3?app_id=${appId}&l=EN&brand=deriv`,
      `wss://ws.binaryws.com/websockets/v3?app_id=${appId}&l=EN&brand=deriv`,
    ];

    let lastErr: Error | null = null;
    for (const url of endpoints) {
      try {
        await this.connectTo(url);
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
      }
    }
    if (lastErr) throw lastErr;

    // Authorize
    const authResp = await this.send({ authorize: apiToken });
    if (authResp.error) throw new Error(authResp.error.message || 'Authorization failed');
    this._accountId = authResp.authorize?.loginid || null;

    // Get balance
    const balResp = await this.send({ balance: 1 });
    this._balance = balResp.balance?.balance ?? null;
    this._connected = true;
  }

  private connectTo(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.on('error', () => reject(new Error(`Failed to connect to ${url}`)));
      ws.on('close', () => {
        this._connected = false;
        this.pending.forEach(({ reject, timer }) => {
          clearTimeout(timer);
          reject(new Error('Connection closed'));
        });
        this.pending.clear();
        this.ws = null;
      });
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          const id = msg.req_id;
          if (id && this.pending.has(id)) {
            const { resolve, reject, timer } = this.pending.get(id)!;
            clearTimeout(timer);
            this.pending.delete(id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg);
          }
          if (msg.msg_type === 'balance') {
            this._balance = msg.balance?.balance ?? this._balance;
          }
        } catch { /* ignore */ }
      });
    });
  }

  private async send<T = any>(msg: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Copy client not connected'));
      }
      const id = this.msgId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${id} timed out`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...msg, req_id: id }));
    });
  }

  async executeTrade(type: string, stake: number, dur: number, durUnit: string, symbol: string, barrierDigit?: number): Promise<void> {
    const propPayload: Record<string, unknown> = {
      proposal: 1, amount: stake, basis: 'stake',
      contract_type: type, currency: 'USD',
      duration: dur, duration_unit: durUnit,
      underlying_symbol: symbol,
    };
    if (['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(type)) {
      propPayload.barrier = String(barrierDigit ?? 5);
    }
    const propResp = await this.send(propPayload);
    if (propResp.error) throw new Error(propResp.error.message);
    const propId = propResp.proposal?.id;
    if (!propId) throw new Error('No proposal ID returned');
    const buyResp = await this.send({ buy: propId, price: stake });
    if (buyResp.error) throw new Error(buyResp.error.message);
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this._accountId = null;
    this._balance = null;
  }
}
