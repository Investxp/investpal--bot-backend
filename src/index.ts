import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { DerivClient } from './deriv-ws.js';
import { DerivEngine } from './deriv-engine.js';
import { PolymarketEngine } from './polymarket-engine.js';
import { SXEngine } from './sx-engine.js';
import { InvestPalEngine } from './investpal-engine.js';
import { CopyTradingPool } from './copy-client.js';
import { store } from './store.js';
import type { TradeConfig, Platform } from './types.js';

const PORT = parseInt(process.env.PORT || '4000', 10);

function createEngine(platform: Platform) {
  switch (platform) {
    case 'deriv': {
      const appId = process.env.DERIV_OAUTH_CLIENT_ID || process.env.DERIV_APP_ID || '';
      if (!appId) throw new Error('Missing DERIV_APP_ID or DERIV_OAUTH_CLIENT_ID');
      return new DerivEngine(new DerivClient(appId, ''));
    }
    case 'polymarket': return new PolymarketEngine();
    case 'sx': return new SXEngine();
    case 'investpal': return new InvestPalEngine();
    default: throw new Error(`Unknown platform: ${platform}`);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let engine: ReturnType<typeof createEngine> | null = null;
let enginePlatform: Platform | null = null;
let derivClient: DerivClient | null = null;
const copyPool = new CopyTradingPool();

function broadcastStatus(msg: Record<string, any>) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WsSocket.OPEN) client.send(json);
  });
}

// ── REST API ─────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json(store.getStatus());
});

app.post('/api/initialize-connection', async (req, res) => {
  const { oauthToken, accountId } = req.body;
  if (!oauthToken || !accountId) return res.status(400).json({ error: 'oauthToken and accountId required' });
  try {
    const appId = process.env.DERIV_OAUTH_CLIENT_ID || process.env.DERIV_APP_ID || '';
    if (!appId) return res.status(500).json({ error: 'DERIV_APP_ID or DERIV_OAUTH_CLIENT_ID not configured' });
    derivClient = new DerivClient(appId, '');
    derivClient.setStatusHandler((connected, reason) => {
      if (connected) store.addLog('[Connection] Deriv OTP WebSocket reconnected', 'success');
      else if (reason) store.addLog(`[Connection] Deriv OTP WebSocket disconnected: ${reason}`, 'warn');
    });
    await derivClient.initialize(oauthToken, accountId);
    store.addLog('[Connection] Deriv OTP WebSocket connected', 'success');
    broadcastStatus({ type: 'connection_status', data: { connected: true, accountId } });
    res.json({ ok: true, connected: true, accountId });
  } catch (err: any) {
    store.addLog(`[Connection] Failed: ${err.message}`, 'error');
    broadcastStatus({ type: 'connection_status', data: { connected: false, error: err.message } });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/start', async (req, res) => {
  if (store.isRunning) return res.status(400).json({ error: 'Already running' });
  const config: TradeConfig = req.body;
  const platform: Platform = config.platform || 'deriv';
  if (platform === 'deriv' && (!derivClient || !derivClient.hasOtpUrl)) {
    return res.status(400).json({ error: 'Deriv connection not initialized. Call /api/initialize-connection first.' });
  }
  try {
    engine = platform === 'deriv' ? new DerivEngine(derivClient!) : createEngine(platform);
    enginePlatform = platform;
    engine.start(config).catch((err: Error) => {
      store.addLog(`[System] Engine error: ${err.message}`, 'error');
      store.stop('Engine error');
    });
    res.json({ ok: true, platform });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stop', async (_req, res) => {
  if (engine) await engine.stop('User requested stop');
  res.json({ ok: true });
});

// ── Copy Trading Bridge (Multi-Follower Pool) ──────────────────────
app.post('/api/copy-followers', (req, res) => {
  const { name, token, connectionType, copyRatio, maxStake, oauthAccountId } = req.body;
  if (!name || !token) return res.status(400).json({ error: 'Name and token are required' });
  const connType: 'pat' | 'oauth2' = connectionType || 'pat';
  const fid = store.addFollower(name, token, connType, copyRatio || 1.0, maxStake || 100.0, oauthAccountId);
  copyPool.sync();
  store.addLog(`[CopyPool] Added follower: ${name} (ID: ${fid})`, 'success');
  res.json({ status: 'SUCCESS', id: fid });
});

app.get('/api/copy-followers', (_req, res) => {
  const followers = store.getFollowers().map(f => ({
    id: f.id, name: f.name, connection_type: f.connection_type,
    token_masked: f.token.length > 10 ? f.token.slice(0, 6) + '...' + f.token.slice(-4) : '...',
    copy_ratio: f.copy_ratio, max_stake: f.max_stake,
    active: f.active, created_at: f.created_at,
    total_trades: f.total_trades, total_pnl: f.total_pnl,
  }));
  res.json(followers);
});

app.post('/api/copy-followers/toggle', (req, res) => {
  const { id, active } = req.body;
  if (!id) return res.status(400).json({ error: 'Follower ID required' });
  store.toggleFollower(id, active);
  copyPool.sync();
  store.addLog(`[CopyPool] Toggled follower ${id} active=${active}`, 'info');
  res.json({ status: 'SUCCESS' });
});

app.delete('/api/copy-followers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid follower ID' });
  store.deleteFollower(id);
  copyPool.sync();
  store.addLog(`[CopyPool] Deleted follower ${id}`, 'warn');
  res.json({ status: 'SUCCESS' });
});

app.get('/api/copy-trade-logs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  res.json(store.getCopyTradeLogs(limit));
});

// Replicate a master trade to all active followers
app.post('/api/copy-replicate', async (req, res) => {
  const { masterSignalId, masterContractId, type, stake, duration, durationUnit, symbol, barrierDigit } = req.body;
  if (!type || !stake || !symbol || masterContractId == null) {
    return res.status(400).json({ error: 'Missing trade params' });
  }
  try {
    await copyPool.replicationTrade(masterSignalId || 0, masterContractId, type, stake, duration, durationUnit, symbol, barrierDigit);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve outcomes for copy trades of a master contract
app.post('/api/copy-resolve', async (req, res) => {
  const { masterContractId } = req.body;
  if (!masterContractId) return res.status(400).json({ error: 'masterContractId required' });
  try {
    await copyPool.resolveOutcomes(masterContractId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Legacy single copy endpoints (backward-compatible)
app.post('/api/copy-init', async (req, res) => {
  const { apiToken, oauthToken, accountId } = req.body;
  if (!apiToken && (!oauthToken || !accountId)) {
    return res.status(400).json({ error: 'Provide either apiToken or oauthToken + accountId' });
  }
  const name = apiToken ? apiToken.slice(0, 8) : (accountId || 'copy');
  const connType: 'pat' | 'oauth2' = apiToken ? 'pat' : 'oauth2';
  const token = apiToken || oauthToken!;
  const fid = store.addFollower(name, token, connType, 1.0, 100.0, connType === 'oauth2' ? accountId : undefined);
  copyPool.sync();
  const client = copyPool.getClient(fid);
  const account = client?.accountId || null;
  const balance = client?.balance || null;
  res.json({ ok: true, accountId: account, balance, followerId: fid });
});

app.post('/api/copy-trade', async (req, res) => {
  const { type, stake, duration, durationUnit, symbol, barrierDigit } = req.body;
  if (!type || !stake || !symbol) return res.status(400).json({ error: 'Missing trade params' });
  try {
    await copyPool.replicationTrade(0, 0, type, stake, duration, durationUnit, symbol, barrierDigit);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/copy-status', (_req, res) => {
  const followers = store.getFollowers();
  const connInfo = followers.map(f => ({
    id: f.id, name: f.name, active: f.active === 1,
    connected: copyPool.getClient(f.id)?.connected ?? false,
    accountId: copyPool.getClient(f.id)?.accountId ?? null,
    balance: copyPool.getClient(f.id)?.balance ?? null,
  }));
  res.json({ connected: connInfo.some(f => f.connected), followers: connInfo });
});

app.post('/api/copy-disconnect', (_req, res) => {
  copyPool.stopAll();
  store.getFollowers().forEach(f => store.deleteFollower(f.id));
  store.addLog('[CopyPool] All followers disconnected and cleared', 'info');
  res.json({ ok: true });
});

app.get('/api/check-token', async (_req, res) => {
  const appId = process.env.DERIV_OAUTH_CLIENT_ID || process.env.DERIV_APP_ID || '';
  if (!appId) return res.json({ valid: false, error: 'DERIV_APP_ID not configured' });
  const connected = derivClient?.connected ?? false;
  const hasOtp = derivClient?.hasOtpUrl ?? false;
  res.json({ valid: connected && hasOtp, connected, hasOtpUrl: hasOtp, accountId: derivClient?.accountId });
});

app.get('/', (_req, res) => {
  res.json({ status: 'ok', name: 'InvestPal Bot Engine', version: '1.0.0', running: store.isRunning, platform: enginePlatform, derivConnected: derivClient?.connected ?? false });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', running: store.isRunning, platform: enginePlatform, connected: engine ? (engine as any).deriv?.connected ?? null : null });
});

// ── WebSocket for real-time updates ──
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', data: store.getStatus() }));
  const heartbeat = setInterval(() => { if (ws.readyState === WsSocket.OPEN) ws.ping(); }, 25000);
  const onStatus = () => { if (ws.readyState === WsSocket.OPEN) ws.send(JSON.stringify({ type: 'status', data: store.getStatus() })); };
  store.subscribe(onStatus);
  const onLog = (log: any) => { if (ws.readyState === WsSocket.OPEN) ws.send(JSON.stringify({ type: 'log', data: log })); };
  store.subscribeLogs(onLog);
  ws.on('close', () => { clearInterval(heartbeat); store.unsubscribe(onStatus); store.unsubscribeLogs(onLog); });
  ws.on('error', () => { clearInterval(heartbeat); store.unsubscribe(onStatus); store.unsubscribeLogs(onLog); });
});

server.listen(PORT, () => {
  console.log(`InvestPal Bot Engine running on port ${PORT}`);
  console.log(`Supported platforms: deriv, polymarket, sx, investpal`);
  console.log(`WS endpoint: ws://localhost:${PORT}/ws`);
  console.log(`API: http://localhost:${PORT}/api/status`);
});

process.on('SIGTERM', async () => {
  if (engine) await engine.stop('Server shutdown');
  copyPool.stopAll();
  server.close();
});