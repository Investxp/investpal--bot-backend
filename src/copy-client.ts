import WebSocket from 'ws';
import https from 'https';
import { store } from './store.js';

const OTP_API_BASE = 'https://api.derivws.com/trading/v1/options';
const WS_LEGACY_APP_ID = process.env.COPY_APP_ID || '1089';
const OAUTH_CLIENT_ID = process.env.DERIV_OAUTH_CLIENT_ID || process.env.DERIV_APP_ID || '019eb681-1505-7bc3-991a-65e6b76a60a4';

class CopyClient {
  private ws: WebSocket | null = null;
  private msgId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private _connected = false;
  private _accountId: string | null = null;
  private _balance: number | null = null;
  private _currency = 'USD';

  get connected() { return this._connected; }
  get accountId() { return this._accountId; }
  get balance() { return this._balance; }
  get currency() { return this._currency; }

  async connect(opts: { oauthToken?: string; accountId?: string; apiToken?: string }): Promise<void> {
    const { oauthToken, accountId, apiToken } = opts;
    if (apiToken) return this.connectLegacy(apiToken);
    if (!oauthToken || !accountId) throw new Error('Provide either apiToken or oauthToken + accountId');
    const wsUrl = await this.callOtpApi(oauthToken, accountId);
    await this.connectTo(wsUrl);
    this._connected = true;
  }

  private async callOtpApi(oauthToken: string, accountId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${OTP_API_BASE}/accounts/${accountId}/otp`);
      const postData = '';
      const req = https.request({
        hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Deriv-App-ID': OAUTH_CLIENT_ID, 'Authorization': `Bearer ${oauthToken}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json.data?.url) { this._accountId = accountId; resolve(json.data.url); }
            else reject(new Error(json.errors?.[0]?.message || `No OTP URL (HTTP ${res.statusCode}). Response: ${body.slice(0, 200)}`));
          } catch {
            reject(new Error(`Invalid OTP API response (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  private async connectLegacy(apiToken: string): Promise<void> {
    const endpoints = [
      `wss://ws.derivws.com/websockets/v3?app_id=${WS_LEGACY_APP_ID}&l=EN&brand=deriv`,
      `wss://ws.binaryws.com/websockets/v3?app_id=${WS_LEGACY_APP_ID}&l=EN&brand=deriv`,
    ];
    let lastErr: Error | null = null;
    for (const url of endpoints) {
      try { await this.connectTo(url); lastErr = null; break; }
      catch (err) { lastErr = err instanceof Error ? err : new Error(String(err)); }
    }
    if (lastErr) throw lastErr;
    const authResp = await this.send({ authorize: apiToken });
    if (authResp.error) throw new Error(authResp.error.message || 'Authorization failed');
    this._accountId = authResp.authorize?.loginid || null;
    this._currency = authResp.authorize?.currency || 'USD';
    const balResp = await this.send({ balance: 1 });
    this._balance = balResp.balance?.balance ?? null;
    this._connected = true;
  }

  private connectTo(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('open', () => { this.ws = ws; resolve(); });
      ws.on('error', () => reject(new Error(`Failed to connect to ${url}`)));
      ws.on('close', () => {
        this._connected = false;
        this.pending.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error('Connection closed')); });
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
          if (msg.msg_type === 'balance') this._balance = msg.balance?.balance ?? this._balance;
        } catch { /* ignore */ }
      });
    });
  }

  private async send<T = any>(msg: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('Copy client not connected'));
      const id = this.msgId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Request ${id} timed out`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...msg, req_id: id }));
    });
  }

  async getProposal(type: string, stake: number, dur: number, durUnit: string, symbol: string, currency: string, barrierDigit?: number): Promise<{ id: string; askPrice: number }> {
    const payload: Record<string, unknown> = {
      proposal: 1, amount: stake, basis: 'stake',
      contract_type: type, currency,
      duration: dur, duration_unit: durUnit,
      underlying_symbol: symbol,
    };
    if (['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(type)) payload.barrier = String(barrierDigit ?? 5);
    const resp = await this.send(payload);
    if (resp.error) throw new Error(resp.error.message);
    const propId = resp.proposal?.id;
    const askPrice = resp.proposal?.ask_price;
    if (!propId || !askPrice) throw new Error('No proposal ID or ask_price returned');
    return { id: propId, askPrice };
  }

  async executeTrade(type: string, stake: number, dur: number, durUnit: string, symbol: string, currency: string, barrierDigit?: number): Promise<{ contractId: number; buyPrice: number }> {
    const { id, askPrice } = await this.getProposal(type, stake, dur, durUnit, symbol, currency, barrierDigit);
    const buyResp = await this.send({ buy: id, price: askPrice });
    if (buyResp.error) throw new Error(buyResp.error.message);
    return { contractId: buyResp.buy?.contract_id, buyPrice: buyResp.buy?.buy_price || askPrice };
  }

  async getOpenContractDetails(contractId: number): Promise<any> {
    const resp = await this.send({ proposal_open_contract: 1, contract_id: contractId });
    if (resp.error) throw new Error(resp.error.message);
    return resp.proposal_open_contract;
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this._connected = false;
    this._accountId = null;
    this._balance = null;
  }
}

export class CopyTradingPool {
  private clients = new Map<number, CopyClient>();

  sync() {
    const followers = store.getFollowers().filter(f => f.active === 1);
    const activeIds = new Set(followers.map(f => f.id));

    for (const [fid, client] of this.clients) {
      if (!activeIds.has(fid)) {
        client.disconnect();
        this.clients.delete(fid);
      }
    }

    for (const f of followers) {
      if (this.clients.has(f.id)) continue;
      const client = new CopyClient();
      const opts: { apiToken?: string; oauthToken?: string; accountId?: string } = {};
      if (f.connection_type === 'pat') {
        opts.apiToken = f.token;
      } else {
        opts.oauthToken = f.token;
        opts.accountId = f.oauth_account_id || undefined;
      }
      client.connect(opts).then(() => {
        store.addLog(`[CopyPool] Connected follower: ${f.name} (${f.id})`, 'success');
      }).catch((err) => {
        store.addLog(`[CopyPool] Failed to connect follower ${f.name}: ${err.message}`, 'error');
      });
      this.clients.set(f.id, client);
    }
  }

  getClient(fid: number): CopyClient | undefined {
    return this.clients.get(fid);
  }

  async replicationTrade(
    masterSignalId: number,
    masterContractId: number,
    type: string,
    stake: number,
    dur: number,
    durUnit: string,
    symbol: string,
    barrierDigit?: number,
  ) {
    const followers = store.getFollowers().filter(f => f.active === 1);
    this.sync();

    for (const f of followers) {
      const client = this.getClient(f.id);
      if (!client || !client.connected) {
        store.logCopyTrade({
          timestamp: new Date().toISOString(), master_signal_id: masterSignalId,
          master_contract_id: masterContractId, follower_id: f.id,
          follower_name: f.name, follower_contract_id: null,
          stake: 0, status: 'FAILED',
          error_msg: 'Client not connected', payout: 0, profit: 0, closed_at: null,
        });
        continue;
      }

      const fStake = Math.max(0.35, Math.min(f.max_stake, stake * f.copy_ratio));
      const currency = client.currency || 'USD';

      try {
        const result = await client.executeTrade(type, fStake, dur, durUnit, symbol, currency, barrierDigit);
        store.logCopyTrade({
          timestamp: new Date().toISOString(), master_signal_id: masterSignalId,
          master_contract_id: masterContractId, follower_id: f.id,
          follower_name: f.name, follower_contract_id: result.contractId,
          stake: fStake, status: 'SUCCESS',
          error_msg: null, payout: 0, profit: 0, closed_at: null,
        });
        store.addLog(`[CopyTrading] Replicated to ${f.name}: ${result.contractId} ($${fStake.toFixed(2)})`, 'success');
      } catch (err: any) {
        store.logCopyTrade({
          timestamp: new Date().toISOString(), master_signal_id: masterSignalId,
          master_contract_id: masterContractId, follower_id: f.id,
          follower_name: f.name, follower_contract_id: null,
          stake: fStake, status: 'FAILED',
          error_msg: err.message, payout: 0, profit: 0, closed_at: null,
        });
        store.addLog(`[CopyTrading] Failed for ${f.name}: ${err.message}`, 'error');
      }
    }
  }

  async resolveOutcomes(masterContractId: number) {
    const logs = store.getCopyTradeLogs(500).filter(l => l.master_contract_id === masterContractId && l.follower_contract_id && l.status === 'SUCCESS' && l.closed_at === null);
    for (const log of logs) {
      const client = this.getClient(log.follower_id);
      if (!client || !client.connected) continue;
      try {
        const details = await client.getOpenContractDetails(log.follower_contract_id!);
        if (details && details.status && details.status !== 'open') {
          const profit = details.profit || 0;
          const payout = details.payout || 0;
          const closedAt = new Date().toISOString();
          store.updateCopyTradeOutcome(log.follower_contract_id!, 'SUCCESS', payout, profit, closedAt);
          store.addLog(`[CopyTrading] Resolved ${log.follower_name}: PnL $${profit.toFixed(2)}`, profit >= 0 ? 'success' : 'error');
        }
      } catch { /* contract may not be resolved yet */ }
    }
  }

  stopAll() {
    for (const [fid, client] of this.clients) {
      client.disconnect();
    }
    this.clients.clear();
  }
}