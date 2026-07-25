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
      const token = process.env.DERIV_TOKEN || '';
      if (!appId || !token) throw new Error('Missing DERIV_APP_ID or DERIV_TOKEN');
      return new DerivEngine(new DerivClient(appId, token));
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

// ── Token verification (broadcast to all WS clients) ──────────────────
function broadcastStatus(msg: Record<string, any>) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WsSocket.OPEN) client.send(json);
  });
}

async function checkDerivToken() {
  const appId = process.env.DERIV_APP_ID || '';
  const token = process.env.DERIV_TOKEN || '';
  if (!appId || !token) return;
  const client = new DerivClient(appId, token);
  const result = await client.verifyToken();
  if (!result.valid) {
    const isExpired = result.error === 'TOKEN_EXPIRED';
    store.addLog(`[Token] Deriv token ${isExpired ? 'EXPIRED' : 'invalid'}: ${result.error}`, 'error');
    broadcastStatus({ type: 'token_error', data: { expired: isExpired, error: result.error } });
    if (isExpired) {
      console.error('WARNING: Deriv API token has expired. Create a new token at https://app.deriv.com/account/api-token');
    }
  } else {
    store.addLog(`[Token] Deriv token valid (${result.loginid})`, 'success');
    broadcastStatus({ type: 'token_status', data: { valid: true, loginid: result.loginid } });
  }
}

// ── REST API ─────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json(store.getStatus());
});

app.post('/api/start', async (req, res) => {
  if (store.isRunning) {
    return res.status(400).json({ error: 'Already running' });
  }
  const config: TradeConfig = req.body;
  const platform: Platform = config.platform || 'deriv';

  try {
    // Stop previous engine if platform changed
    if (engine && enginePlatform !== platform) {
      await engine.stop('Platform switch');
      engine = null;
    }

    if (!engine || enginePlatform !== platform) {
      engine = createEngine(platform);
      enginePlatform = platform;
    }

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
  try {
    const appId = process.env.DERIV_APP_ID || '';
    const token = process.env.DERIV_TOKEN || '';
    if (!appId || !token) return res.json({ valid: false, error: 'DERIV_APP_ID or DERIV_TOKEN not set' });
    const client = new DerivClient(appId, token);
    const result = await client.verifyToken();
    res.json(result);
  } catch (err: any) {
    res.json({ valid: false, error: err.message });
  }
});

// Health check
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

  // Ping/pong keep-alive every 25s
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
  checkDerivToken();
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (engine) await engine.stop('Server shutdown');
  server.close();
});
