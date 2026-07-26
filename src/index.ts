import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { DerivClient } from './deriv-ws.js';
import { DerivEngine } from './deriv-engine.js';
import { PolymarketEngine } from './polymarket-engine.js';
import { SXEngine } from './sx-engine.js';
import { InvestPalEngine } from './investpal-engine.js';
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
