import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { DerivClient } from './deriv-ws.js';
import { DerivEngine } from './deriv-engine.js';
import { PolymarketEngine } from './polymarket-engine.js';
import { SXEngine } from './sx-engine.js';
import { InvestPalEngine } from './investpal-engine.js';
import { CopyClient } from './copy-client.js';
import { store } from './store.js';
import type { TradeConfig, Platform } from './types.js';

const PORT = parseInt(process.env.PORT || '4000', 10);

// ── Engine factory ────────────────────────────────────────────────────
function createEngine(platform: Platform) {
  switch (platform) {
    case 'deriv': {
      const appId = process.env.DERIV_APP_ID || '';
      if (!appId) throw new Error('Missing DERIV_APP_ID');
      return new DerivEngine(new DerivClient(appId, ''));
    }
    case 'polymarket': return new PolymarketEngine();
    case 'sx': return new SXEngine();
    case 'investpal': return new InvestPalEngine();
    default: throw new Error(`Unknown platform: ${platform}`);
  }
}

// ── Init ──────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

let engine: ReturnType<typeof createEngine> | null = null;
let enginePlatform: Platform | null = null;
let derivClient: DerivClient | null = null;
let copyClient: CopyClient | null = null;

// ── Helper: broadcast to all WS clients ────────────────────────────────
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

// Initialize Deriv OTP WebSocket connection
app.post('/api/initialize-connection', async (req, res) => {
  const { oauthToken, accountId } = req.body;
  if (!oauthToken || !accountId) {
    return res.status(400).json({ error: 'oauthToken and accountId required' });
  }
  try {
    const appId = process.env.DERIV_APP_ID || '';
    if (!appId) return res.status(500).json({ error: 'DERIV_APP_ID not configured' });

    derivClient = new DerivClient(appId, '');
    derivClient.setStatusHandler((connected, reason) => {
      if (connected) {
        store.addLog('[Connection] Deriv OTP WebSocket reconnected', 'success');
      } else if (reason) {
        store.addLog(`[Connection] Deriv OTP WebSocket disconnected: ${reason}`, 'warn');
      }
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
  if (store.isRunning) {
    return res.status(400).json({ error: 'Already running' });
  }
  const config: TradeConfig = req.body;
  const platform: Platform = config.platform || 'deriv';

  // For deriv, ensure OTP connection is initialized
  if (platform === 'deriv' && (!derivClient || !derivClient.hasOtpUrl)) {
    return res.status(400).json({ error: 'Deriv connection not initialized. Call /api/initialize-connection first.' });
  }

  try {
    if (platform === 'deriv') {
      engine = new DerivEngine(derivClient!);
    } else {
      engine = createEngine(platform);
    }
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

// ── Copy Trading Bridge ─────────────────────────────────────────────
app.post('/api/copy-init', async (req, res) => {
  const { apiToken, oauthToken, accountId } = req.body;
  if (!apiToken && (!oauthToken || !accountId)) {
    return res.status(400).json({ error: 'Provide either apiToken (PAT) or oauthToken + accountId' });
  }
  try {
    if (copyClient) { copyClient.disconnect(); copyClient = null; }
    const client = new CopyClient();
    await client.connect({ apiToken, oauthToken, accountId });
    copyClient = client;
    store.addLog(`[CopyBridge] Connected to target account ${client.accountId}`, 'success');
    res.json({ ok: true, accountId: client.accountId, balance: client.balance });
  } catch (err: any) {
    store.addLog(`[CopyBridge] Init failed: ${err.message}`, 'error');
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/copy-trade', async (req, res) => {
  if (!copyClient || !copyClient.connected) {
    return res.status(400).json({ error: 'Copy client not connected' });
  }
  const { type, stake, duration, durationUnit, symbol, barrierDigit } = req.body;
  if (!type || !stake || !symbol) return res.status(400).json({ error: 'Missing trade params' });
  try {
    await copyClient.executeTrade(type, stake, duration, durationUnit, symbol, barrierDigit);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/copy-status', (_req, res) => {
  if (!copyClient) return res.json({ connected: false });
  res.json({
    connected: copyClient.connected,
    accountId: copyClient.accountId,
    balance: copyClient.balance,
  });
});

app.post('/api/copy-disconnect', (_req, res) => {
  if (copyClient) { copyClient.disconnect(); copyClient = null; }
  store.addLog('[CopyBridge] Disconnected', 'info');
  res.json({ ok: true });
});

app.get('/api/check-token', async (_req, res) => {
  const appId = process.env.DERIV_APP_ID || '';
  if (!appId) return res.json({ valid: false, error: 'DERIV_APP_ID not configured' });
  const connected = derivClient?.connected ?? false;
  const hasOtp = derivClient?.hasOtpUrl ?? false;
  res.json({ valid: connected && hasOtp, connected, hasOtpUrl: hasOtp, accountId: derivClient?.accountId });
});

// Health check
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    name: 'InvestPal Bot Engine',
    version: '1.0.0',
    running: store.isRunning,
    platform: enginePlatform,
    derivConnected: derivClient?.connected ?? false,
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    running: store.isRunning,
    platform: enginePlatform,
    connected: engine ? (engine as any).deriv?.connected ?? null : null,
  });
});

// ── WebSocket for real-time updates ──────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'status', data: store.getStatus() }));

  const heartbeat = setInterval(() => {
    if (ws.readyState === WsSocket.OPEN) {
      ws.ping();
    }
  }, 25000);

  const onStatus = () => {
    if (ws.readyState === WsSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'status', data: store.getStatus() }));
    }
  };
  store.subscribe(onStatus);

  const onLog = (log: any) => {
    if (ws.readyState === WsSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'log', data: log }));
    }
  };
  store.subscribeLogs(onLog);

  ws.on('close', () => {
    clearInterval(heartbeat);
    store.unsubscribe(onStatus);
    store.unsubscribeLogs(onLog);
  });

  ws.on('error', () => {
    clearInterval(heartbeat);
    store.unsubscribe(onStatus);
    store.unsubscribeLogs(onLog);
  });
});

// ── Start ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`InvestPal Bot Engine running on port ${PORT}`);
  console.log(`Supported platforms: deriv, polymarket, sx, investpal`);
  console.log(`WS endpoint: ws://localhost:${PORT}/ws`);
  console.log(`API: http://localhost:${PORT}/api/status`);
  console.log('Use POST /api/initialize-connection to connect to Deriv via OTP');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (engine) await engine.stop('Server shutdown');
  server.close();
});
