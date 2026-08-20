import WebSocket from 'ws';
import https from 'https';
import { store } from './store.js';

const OTP_API_BASE = 'https://api.derivws.com/trading/v1/options';
// Deriv universal app ID — all OTP calls use this
const OAUTH_CLIENT_ID = '33O6s5sRWxywmFZAGbjBf';

type TokenType = 'pat' | 'oauth2';

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

  /**
   * Connect via Deriv OTP API — works for both PAT and OAuth2 tokens.
   * The OTP endpoint accepts any valid Deriv token as Bearer token
   * and returns a temporary WebSocket URL (no authorize step needed).
   * @param preferredAccountType 'demo' | 'live' — which account type to resolve (PAT flow only)
   */
  async connect(token: string, tokenType: TokenType, targetAccountId?: string, preferredAccountType?: 'demo' | 'live'): Promise<void> {
    const wsUrl = await this.callOtpApi(token, tokenType, targetAccountId, preferredAccountType);
    await this.connectTo(wsUrl);
    this._connected = true;
  }

  private async callOtpApi(token: string, tokenType: TokenType, targetAccountId?: string, preferredAccountType?: 'demo' | 'live'): Promise<string> {
    // Step 1: If no targetAccountId provided (PAT flow), resolve from accounts list
    let accountId = targetAccountId;
    if (!accountId) {
      accountId = await this.resolveAccountId(token, preferredAccountType);
    }

    // Step 2: Get OTP session URL for the resolved account
    return this.otpSession(token, accountId);
  }

  private resolveAccountId(token: string, preferredAccountType?: 'demo' | 'live'): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        {
          hostname: 'api.derivws.com',
          path: '/trading/v1/options/accounts',
          headers: {
            'Deriv-App-ID': OAUTH_CLIENT_ID,
            'Authorization': `Bearer ${token}`,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(body);
              const accounts = json.data || [];
              if (!accounts.length) {
                return reject(new Error(`No accounts found (HTTP ${res.statusCode})`));
              }
              // Deriv API uses 'demo' for demo and 'real' for live; map 'live' → 'real'
              const apiType = preferredAccountType === 'live' ? 'real' : preferredAccountType;
              const filtered = apiType
                ? accounts.filter((a: any) => a.account_type === apiType && a.status === 'active')
                : accounts.filter((a: any) => a.status === 'active');
              const chosen = filtered[0];
              if (!chosen) {
                // Fall back to any active account with correct prefix match (DOT=demo, ROT=real)
                const prefixMatch = preferredAccountType === 'demo'
                  ? accounts.find((a: any) => (a.account_id || '').startsWith('DOT') && a.status === 'active')
                  : preferredAccountType === 'live'
                    ? accounts.find((a: any) => (a.account_id || '').startsWith('ROT') && a.status === 'active')
                    : accounts.find((a: any) => a.status === 'active');
                if (!prefixMatch) return reject(new Error(`No ${preferredAccountType || 'active'} account found`));
                this._accountId = prefixMatch.account_id;
                this._currency = prefixMatch.currency || 'USD';
                this._balance = parseFloat(prefixMatch.balance || '0');
                store.addLog(`[CopyClient] Resolved account (prefix): ${prefixMatch.account_id} (${preferredAccountType}, ${prefixMatch.currency})`, 'info');
                return resolve(prefixMatch.account_id);
              }
              this._accountId = chosen.account_id;
              this._currency = chosen.currency || 'USD';
              this._balance = parseFloat(chosen.balance || '0');
              store.addLog(`[CopyClient] Resolved account: ${chosen.account_id} (${chosen.account_type}, ${chosen.currency})`, 'info');
              resolve(chosen.account_id);
            } catch {
              reject(new Error(`Invalid accounts response (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
            }
          });
        },
      );
      req.on('error', reject);
    });
  }

  private otpSession(token: string, accountId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${OTP_API_BASE}/accounts/${accountId}/otp`);
      const postData = '';
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Deriv-App-ID': OAUTH_CLIENT_ID,
            'Authorization': `Bearer ${token}`,
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
                reject(new Error(json.errors?.[0]?.message || `No OTP URL (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
              }
            } catch {
              reject(new Error(`Invalid OTP response (HTTP ${res.statusCode}): ${body.slice(0, 200)}`));
            }
          });
        },
      );
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
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

  async getProposal(type: string, stake: number, dur: number, durUnit: string, symbol: string, currency: string, barrierDigit?: number, barrierOffset?: string): Promise<{ id: string; askPrice: number }> {
    const payload: Record<string, unknown> = {
      proposal: 1, amount: stake, basis: 'stake',
      contract_type: type, currency,
      duration: dur, duration_unit: durUnit,
      underlying_symbol: symbol,
    };
    if (['DIGITMATCH', 'DIGITDIFF', 'DIGITOVER', 'DIGITUNDER'].includes(type)) payload.barrier = String(barrierDigit ?? 5);
    // Single-barrier contracts REQUIRE a barrier even when the master omitted one.
    const isSingleBarrier = ['HIGHER', 'LOWER', 'ONETOUCH', 'NOTOUCH', 'TURBOSLONG', 'TURBOSSHORT'].includes(type);
    if (isSingleBarrier) {
      const raw = barrierOffset || '0.00';
      const pos = raw.startsWith('+') || !raw.startsWith('-');
      if (['HIGHER', 'ONETOUCH', 'TURBOSLONG'].includes(type)) {
        payload.barrier = pos ? ('+' + raw.replace(/^\+/, '')) : raw;
      } else {
        payload.barrier = pos ? ('-' + raw.replace(/^\+/, '')) : raw;
      }
    } else if (['EXPIRYRANGE', 'EXPIRYMISS', 'RANGE', 'UPORDOWN'].includes(type)) {
      const raw = barrierOffset || '0.00';
      const isPos = raw.startsWith('+') && !raw.startsWith('-');
      const isNeg = raw.startsWith('-');
      const numVal = parseFloat(raw.replace(/[+\-]/, ''));
      if (!isNaN(numVal) && numVal > 0) {
        payload.barrier = isNeg ? ('-' + numVal.toFixed(2)) : '+0.00';
        payload.barrier2 = isPos ? ('+' + numVal.toFixed(2)) : '+0.00';
      } else {
        payload.barrier = '+0.00';
        payload.barrier2 = '+0.01';
      }
    }
    const resp = await this.send(payload);
    if (resp.error) throw new Error(resp.error.message);
    const propId = resp.proposal?.id;
    const askPrice = resp.proposal?.ask_price;
    if (!propId || !askPrice) throw new Error('No proposal ID or ask_price returned');
    return { id: propId, askPrice };
  }

  async executeTrade(type: string, stake: number, dur: number, durUnit: string, symbol: string, currency: string, barrierDigit?: number, barrierOffset?: string): Promise<{ contractId: number; buyPrice: number }> {
    const { id, askPrice } = await this.getProposal(type, stake, dur, durUnit, symbol, currency, barrierDigit, barrierOffset);
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
      // Map copy_type to preferred account type
      const preferredAccountType: 'demo' | 'live' | undefined =
        f.copy_type === 'demo_to_demo' || f.copy_type === 'live_to_demo' ? 'demo' :
        f.copy_type === 'demo_to_live' || f.copy_type === 'live_to_live' ? 'live' : undefined;
      const connectPromise = f.connection_type === 'pat'
        ? client.connect(f.token, 'pat', undefined, preferredAccountType)
        : client.connect(f.token, 'oauth2', f.oauth_account_id || undefined);
      connectPromise.then(() => {
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
    barrierOffset?: string,
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
        const result = await client.executeTrade(type, fStake, dur, durUnit, symbol, currency, barrierDigit, barrierOffset);
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