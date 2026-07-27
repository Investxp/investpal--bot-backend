import WebSocket from 'ws';
import https from 'https';

const OTP_API_BASE = 'https://api.derivws.com/trading/v1/options';
const LEGACY_APP_ID = process.env.COPY_APP_ID || '1089';

/**
 * Copy trading client — supports both the new Deriv OTP WebSocket API
 * (OAuth2 token) and legacy v3 WS (PAT token).
 */
export class CopyClient {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private _connected = false;
  private _accountId: string | null = null;
  private _balance: number | null = null;

  get connected() { return this._connected; }
  get accountId() { return this._accountId; }
  get balance() { return this._balance; }

  /**
   * Connect using either:
   * - OAuth2 flow (new API): provide `oauthToken` + `accountId` (e.g. CR1234567)
   * - PAT flow (legacy): provide `apiToken` (PAT token like pat_...)
   */
  async connect(opts: { oauthToken?: string; accountId?: string; apiToken?: string }): Promise<void> {
    const { oauthToken, accountId, apiToken } = opts;

    if (apiToken) {
      // Legacy v3 WS with PAT token
      return this.connectLegacy(apiToken);
    }

    if (!oauthToken || !accountId) {
      throw new Error('Provide either an apiToken (PAT) or oauthToken + accountId');
    }

    // New OTP flow
    const wsUrl = await this.callOtpApi(oauthToken, accountId);
    await this.connectTo(wsUrl);
    this._connected = true;
  }

  private async callOtpApi(oauthToken: string, accountId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${OTP_API_BASE}/accounts/${accountId}/otp`);
      const postData = '';
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Deriv-App-ID': LEGACY_APP_ID,
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
                this._accountId = accountId;
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
      req.write(postData);
      req.end();
    });
  }

  private async connectLegacy(apiToken: string): Promise<void> {
    const endpoints = [
      `wss://ws.derivws.com/websockets/v3?app_id=${LEGACY_APP_ID}&l=EN&brand=deriv`,
      `wss://ws.binaryws.com/websockets/v3?app_id=${LEGACY_APP_ID}&l=EN&brand=deriv`,
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

    const authResp = await this.send({ authorize: apiToken });
    if (authResp.error) throw new Error(authResp.error.message || 'Authorization failed');
    this._accountId = authResp.authorize?.loginid || null;

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