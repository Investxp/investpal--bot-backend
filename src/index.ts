import express from 'express';
import cors from 'cors';
import path from 'path';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { WebSocketServer, WebSocket as WsSocket } from 'ws';
import { DerivClient } from './deriv-ws.js';
import { DerivEngine } from './deriv-engine.js';
import { PolymarketEngine } from './polymarket-engine.js';
import { SXEngine } from './sx-engine.js';
import { InvestPalEngine } from './investpal-engine.js';
import { CopyTradingPool } from './copy-client.js';
import { store } from './store.js';
import { StrategyRotatorAgent } from './agents/strategy-rotator.js';
import { LLMAgent } from './agents/llm-agent.js';
import { HybridAgent } from './agents/hybrid-agent.js';
import type { TradeConfig, Platform } from './types.js';
import type { CopyType } from './store.js';
import type { AgentConfig, AgentEngine } from './agent-engine.js';
import { evaluateTradeConfig, evaluateTradeRisk } from './risk-gate.js';
import { PostgresExecutionPersistence } from './postgres-persistence.js';
import { PaperExecutionAdapter } from './paper-execution.js';
import { IdempotencyService } from './idempotency.js';
import { AuditLogger } from './audit-logger.js';
import { TradeJournal } from './trade-journal.js';
import { AccountAuthorization } from './account-authorization.js';
import { getRequestSession, parseBearerToken } from './auth.js';
import { createStrategyVersion, findLatestVersion, rollbackStrategyToVersion, validateVersionChain, type StrategyVersionRecord } from './strategy-versioning.js';
import { evaluateCapitalProtection } from './capital-protection.js';
import { createJobQueue, createExecutionJob } from './job-queue.js';

const PORT = parseInt(process.env.PORT || '4000', 10);

// ── API authentication ─────────────────────────────────────────────
// Set API_AUTH_TOKEN to protect every /api/* route and the /ws socket.
// In production the server FAILS CLOSED: if no token is configured,
// all /api/* requests are rejected with 503 until one is set.
const API_TOKEN = process.env.API_AUTH_TOKEN || '';
const IS_PROD = process.env.NODE_ENV === 'production';

function isAuthorized(req: express.Request): boolean {
  const session = getRequestSession(req as any);
  if (session) {
    return true;
  }

  if (!API_TOKEN) return IS_PROD ? false : true; // dev: open + warned; prod: fail closed
  const auth = req.headers.authorization || '';
  const key = (req.headers['x-api-key'] as string) || '';
  return auth === `Bearer ${API_TOKEN}` || key === API_TOKEN || parseBearerToken(req as any) === API_TOKEN;
}

function apiAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (isAuthorized(req)) return next();
  if (!API_TOKEN && IS_PROD) {
    return res.status(503).json({ error: 'Server misconfigured: API_AUTH_TOKEN environment variable is required in production' });
  }
  if (!API_TOKEN) {
    console.warn('[Security] ⚠️  API_AUTH_TOKEN is NOT set — /api/* endpoints are OPEN (development mode only)');
  }
  return res.status(401).json({ error: 'Unauthorized: missing or invalid API token or session' });
}

const apiRateWindows = new Map<string, { startedAt: number; count: number }>();
const rateLimitCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, window] of apiRateWindows) if (window.startedAt < cutoff) apiRateWindows.delete(key);
}, 5 * 60 * 1000);
function apiRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const current = apiRateWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    apiRateWindows.set(key, { startedAt: now, count: 1 });
    return next();
  }
  current.count++;
  if (current.count > 120) return res.status(429).json({ error: 'Too many API requests; retry shortly' });
  return next();
}

// ── CORS: allow only known frontend origins ────────────────────────
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'http://localhost:3005,http://localhost:4003,http://localhost:3000,https://investpal-bot.onrender.com,https://investpal.online,https://investpal.io')
  .split(',').map(s => s.trim()).filter(Boolean);

function createEngine(platform: Platform) {
  switch (platform) {
    case 'deriv': {
      return new DerivEngine(new DerivClient(''));
    }
    case 'polymarket': return new PolymarketEngine();
    case 'sx': return new SXEngine();
    case 'investpal': return new InvestPalEngine();
    default: throw new Error(`Unknown platform: ${platform}`);
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false); // no CORS headers → browser blocks the call
  },
}));
app.use(express.json({ limit: '256kb' }));
app.disable('x-powered-by');
app.use((_req, res, next) => {
  const supplied = _req.header('X-Correlation-ID');
  const correlationId = supplied && /^[a-zA-Z0-9._:-]{1,100}$/.test(supplied) ? supplied : randomUUID();
  res.setHeader('X-Correlation-ID', correlationId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// Protect every /api/* route with the shared token
app.use('/api', apiRateLimit, apiAuth);
app.use('/bot', express.static(path.join(process.cwd(), 'public', 'bot')));

const server = createServer(app);
// noServer: the WebSocketServer does not self-register upgrade handling —
// we intercept 'upgrade' on the HTTP server to enforce auth BEFORE the
// handshake completes (proper ws v8 pattern).
const wss = new WebSocketServer({ noServer: true });

let engine: ReturnType<typeof createEngine> | null = null;
let enginePlatform: Platform | null = null;
let derivClient: DerivClient | null = null;
let postgresPersistence: PostgresExecutionPersistence | null = null;
let idempotencyService: IdempotencyService;
let auditLogger: AuditLogger;
let tradeJournal: TradeJournal;
let accountAuthz: AccountAuthorization;
const copyPool = new CopyTradingPool();
const paperAdapter = new PaperExecutionAdapter();
store.copyPoolRef = copyPool;
copyPool.startAutoResync(30000);
const reconciliationTimer = setInterval(() => {
  if (!derivClient?.connected || store.getExecutions(1).length === 0) return;
  fetch(`http://127.0.0.1:${PORT}/api/reconciliation/run`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_TOKEN}` },
  }).catch((error: unknown) => store.addLog(`[Reconciliation] Scheduled run failed: ${error instanceof Error ? error.message : 'unknown error'}`, 'warn'));
}, 5 * 60 * 1000);

if (process.env.DATABASE_URL) {
  const persistence = new PostgresExecutionPersistence(process.env.DATABASE_URL);
  postgresPersistence = persistence;
  const pool = persistence['pool'] || null; // Access internal pool for other services
  idempotencyService = new IdempotencyService(pool);
  auditLogger = new AuditLogger(pool);
  tradeJournal = new TradeJournal(pool);
  accountAuthz = new AccountAuthorization(pool);
  store.configureExecutionPersistence(persistence);
  persistence.check().then(() => store.restoreExecutions()).catch((error: unknown) => {
    store.addLog(`[Persistence] PostgreSQL unavailable: ${error instanceof Error ? error.message : 'unknown error'}`, 'error');
  });
} else {
  idempotencyService = new IdempotencyService(null);
  auditLogger = new AuditLogger(null);
  tradeJournal = new TradeJournal(null);
  accountAuthz = new AccountAuthorization(null);
}

function broadcastStatus(msg: Record<string, any>) {
  const json = JSON.stringify(msg);
  wss.clients.forEach((client) => {
    if (client.readyState === WsSocket.OPEN) client.send(json);
  });
}

const strategyVersionStore = new Map<string, StrategyVersionRecord[]>();const executionQueue = createJobQueue({ maxAttempts: 3 });
// ── REST API ─────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  res.json(store.getStatus());
});

app.get('/api/strategies/:id/versions', (req, res) => {
  const versions = strategyVersionStore.get(req.params.id) ?? [];
  res.json({ strategyId: req.params.id, versions, latest: findLatestVersion(versions) });
});

app.post('/api/strategies/:id/versions', (req, res) => {
  const { version, config, status = 'draft' } = req.body ?? {};
  if (!version || typeof version !== 'string') {
    return res.status(400).json({ error: 'version is required' });
  }

  const existing = strategyVersionStore.get(req.params.id) ?? [];
  const next = createStrategyVersion({ strategyId: req.params.id, version, config, status });
  const merged = [...existing, next];
  const validation = validateVersionChain(merged);
  if (!validation.valid) {
    return res.status(422).json({ error: validation.error || 'Invalid version chain' });
  }

  strategyVersionStore.set(req.params.id, merged);
  res.status(201).json({ strategyId: req.params.id, version: next, latest: findLatestVersion(merged) });
});

app.post('/api/strategies/:id/versions/rollback', (req, res) => {
  const { targetVersion, currentVersion, currentConfig } = req.body ?? {};
  if (!targetVersion || typeof targetVersion !== 'string') {
    return res.status(400).json({ error: 'targetVersion is required' });
  }

  const versions = strategyVersionStore.get(req.params.id) ?? [];
  if (versions.length === 0) {
    return res.status(404).json({ error: 'No versions found for this strategy' });
  }

  try {
    const rolled = rollbackStrategyToVersion({
      strategyId: req.params.id,
      currentVersion: currentVersion ?? findLatestVersion(versions)?.version ?? '',
      currentConfig: currentConfig ?? findLatestVersion(versions)?.config ?? {},
      versions,
      targetVersion,
    });
    const updated = versions.map((item) => (item.version === rolled.version ? rolled : item));
    strategyVersionStore.set(req.params.id, updated);
    res.json({ strategyId: req.params.id, rolledVersion: rolled, latest: findLatestVersion(updated) });
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : 'Rollback failed' });
  }
});

app.get('/api/account-context', (_req, res) => {
  res.json({ accountId: derivClient?.accountId ?? null, connected: derivClient?.connected ?? false });
});

app.get('/api/executions', (req, res) => {
  const limit = Number.parseInt(String(req.query.limit || '100'), 10);
  res.json({ executions: store.getExecutions(Number.isFinite(limit) ? limit : 100) });
});

app.post('/api/paper/execute', (req, res) => {
  const idempotencyKey = req.headers['idempotency-key'] as string || idempotencyService.generateKey();
  const requestedConfig = { ...(req.body as Partial<TradeConfig>), platform: 'deriv', executionMode: 'paper' } as TradeConfig;
  const decision = evaluateTradeConfig(requestedConfig);
  if (!decision.approved) return res.status(422).json({ error: 'Paper configuration blocked by risk gate', reasons: decision.reasons });
  if (store.isEmergencyStopActive()) return res.status(423).json({ error: 'Paper execution blocked by emergency stop' });
  
  const config = decision.normalizedConfig;
  const execution = store.beginExecution({ leg: 'leg1', accountId: null, symbol: config.symbol, contractType: String(req.body.contractType || 'CALL'), stake: config.baseStake, idempotencyKey });
  try {
    store.updateExecution(execution.executionId, 'RISK_CHECK');
    
    // Trade-level risk validation
    const tradeRiskDecision = evaluateTradeRisk(config, config.baseStake, store.stats, store.leg1);
    if (!tradeRiskDecision.approved) {
      store.updateExecution(execution.executionId, 'RISK_BLOCKED', { error: tradeRiskDecision.reason });
      return res.status(422).json({ error: 'Paper execution blocked by trade-level risk gate', reason: tradeRiskDecision.reason });
    }
    
    store.updateExecution(execution.executionId, 'APPROVED');
    const contract = paperAdapter.place(execution.executionId, config.symbol, execution.contractType, config.baseStake);
    store.updateExecution(execution.executionId, 'OPEN', { contractId: contract.contractId });
    res.status(201).json({ mode: 'paper', execution: store.getExecution(execution.executionId), contract, idempotencyKey });
  } catch (error) {
    store.updateExecution(execution.executionId, 'FAILED', { error: error instanceof Error ? error.message : 'Paper execution failed' });
    res.status(500).json({ error: 'Paper execution failed' });
  }
});

app.post('/api/paper/settle/:executionId', (req, res) => {
  const execution = store.getExecution(req.params.executionId);
  if (!execution || execution.contractId === null) return res.status(404).json({ error: 'Paper execution not found' });
  if (execution.state !== 'OPEN') return res.status(409).json({ error: 'Paper execution is not open' });
  try {
    const contract = paperAdapter.settle(execution.contractId, req.body?.won === true, Number(req.body?.payout || 0));
    store.updateExecution(execution.executionId, 'RESULT', { result: contract.status === 'won' ? 'win' : 'loss', profit: contract.profit });
    res.json({ mode: 'paper', execution: store.getExecution(execution.executionId), contract });
  } catch (error) {
    res.status(422).json({ error: error instanceof Error ? error.message : 'Paper settlement failed' });
  }
});

app.post('/api/reconciliation/run', async (_req, res) => {
  if (!derivClient?.connected) return res.status(409).json({ error: 'Deriv connection is not available' });
  const candidates = store.getExecutions(500).filter((execution) => execution.accountId === derivClient?.accountId && execution.contractId !== null);
  const discrepancies: Array<{ executionId: string; contractId: number; issue: string; brokerState?: string; brokerProfit?: number }> = [];
  for (const execution of candidates) {
    try {
      const broker = await derivClient.getContractStatus(execution.contractId!);
      const terminal = ['won', 'profit', 'sold', 'lost'].includes(broker.status);
      if (execution.state === 'OPEN' && terminal) {
        discrepancies.push({ executionId: execution.executionId, contractId: execution.contractId!, issue: 'Local execution is open but broker reports terminal', brokerState: broker.status, brokerProfit: broker.profit });
      }
      if (execution.state === 'RESULT' && !terminal) {
        discrepancies.push({ executionId: execution.executionId, contractId: execution.contractId!, issue: 'Local execution is settled but broker reports non-terminal', brokerState: broker.status, brokerProfit: broker.profit });
      }
      if (execution.state === 'RESULT' && execution.profit !== null && Math.abs(execution.profit - broker.profit) > 0.01) {
        discrepancies.push({ executionId: execution.executionId, contractId: execution.contractId!, issue: 'Profit differs from broker record', brokerState: broker.status, brokerProfit: broker.profit });
      }
    } catch (error) {
      discrepancies.push({ executionId: execution.executionId, contractId: execution.contractId!, issue: `Broker lookup failed: ${error instanceof Error ? error.message : 'unknown error'}` });
    }
  }
  store.addLog(`[Reconciliation] Checked ${candidates.length} execution(s); ${discrepancies.length} discrepancy(ies)`, discrepancies.length ? 'warn' : 'success');
  res.json({ checked: candidates.length, discrepancies, checkedAt: new Date().toISOString() });
});

app.get('/api/emergency-stop', (_req, res) => {
  res.json({ active: store.isEmergencyStopActive() });
});

app.post('/api/emergency-stop', (req, res) => {
  store.triggerEmergencyStop(typeof req.body?.reason === 'string' ? req.body.reason : undefined);
  if (engine) void engine.stop('Emergency stop');
  res.json({ ok: true, active: true });
});

app.delete('/api/emergency-stop', (_req, res) => {
  store.clearEmergencyStop();
  res.json({ ok: true, active: false });
});

app.post('/api/initialize-connection', async (req, res) => {
  const { oauthToken, accountId } = req.body;
  if (!oauthToken || !accountId) return res.status(400).json({ error: 'oauthToken and accountId required' });
  try {
    derivClient = new DerivClient('');
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
  if (store.isEmergencyStopActive()) return res.status(423).json({ error: 'Trading is blocked by emergency stop' });
  
  // Generate idempotency key for this request
  const idempotencyKey = req.headers['idempotency-key'] as string || idempotencyService.generateKey();
  const requestedConfig = { ...(req.body as Partial<TradeConfig>), platform: (req.body as Partial<TradeConfig>).platform || 'deriv' } as TradeConfig;
  
  const decision = evaluateTradeConfig(requestedConfig);
  if (!decision.approved) {
    store.addLog(`[Risk] Start blocked: ${decision.reasons.join('; ')}`, 'error');
    return res.status(422).json({ error: 'Trade configuration blocked by risk gate', reasons: decision.reasons });
  }
  
  const config = decision.normalizedConfig;
  for (const warning of decision.warnings) store.addLog(`[Risk] ${warning}`, 'warn');
  const platform: Platform = config.platform || 'deriv';
  const executionMode = config.executionMode || 'demo';
  
  // Determine account ID based on platform and mode
  let accountId: string | null = null;
  if (platform === 'deriv' && derivClient?.accountId) {
    accountId = derivClient.accountId;
  }
  
  // Check idempotency key to prevent duplicate submissions
  if (postgresPersistence && accountId) {
    const existingExecutionId = await postgresPersistence.checkIdempotencyKey(accountId, idempotencyKey);
    if (existingExecutionId) {
      const cachedExecution = store.getExecution(existingExecutionId);
      if (cachedExecution) {
        store.addLog(`[Idempotency] Duplicate request detected; returning cached result`, 'warn');
        return res.status(200).json({ ok: true, platform, executionId: existingExecutionId, cached: true });
      }
    }
  }
  
  // Handle paper trading mode
  if (executionMode === 'paper') {
    try {
      store.reset(config);
      const execution = store.beginExecution({ leg: 'leg1', accountId, symbol: config.symbol, contractType: 'CALL', stake: config.baseStake, idempotencyKey });
      store.updateExecution(execution.executionId, 'VALIDATING');
      store.updateExecution(execution.executionId, 'RISK_CHECK');
      store.updateExecution(execution.executionId, 'APPROVED');
      
      // Create initial paper contract for testing
      const paperContract = paperAdapter.place(execution.executionId, config.symbol, 'CALL', config.baseStake);
      store.updateExecution(execution.executionId, 'OPEN', { contractId: paperContract.contractId });
      store.addLog(`[Paper] Paper trading session started (execution: ${execution.executionId})`, 'success');
      
      res.status(201).json({ 
        ok: true, 
        mode: 'paper', 
        platform, 
        executionId: execution.executionId,
        idempotencyKey,
        contract: paperContract 
      });
    } catch (err: any) {
      store.addLog(`[Paper] Paper execution failed: ${err.message}`, 'error');
      res.status(500).json({ error: 'Paper execution initialization failed' });
    }
    return;
  }
  
  if (executionMode === 'backtest') {
    return res.status(501).json({ error: `${executionMode} execution is not implemented; no broker trade was submitted` });
  }
  
  if (executionMode === 'live' && (process.env.ALLOW_LIVE_TRADING !== 'true' || req.body?.confirmLive !== true)) {
    store.addLog('[Risk] Live start blocked: explicit live authorization is missing', 'error');
    return res.status(403).json({ error: 'Live trading requires ALLOW_LIVE_TRADING=true and confirmLive=true' });
  }
  
  if (platform === 'deriv' && (!derivClient || !derivClient.hasOtpUrl)) {
    return res.status(400).json({ error: 'Deriv connection not initialized. Call /api/initialize-connection first.' });
  }
  
  const requestedAccountId = typeof req.body?.accountId === 'string' ? req.body.accountId : null;
  if (platform === 'deriv' && requestedAccountId && requestedAccountId !== derivClient?.accountId) {
    return res.status(403).json({ error: 'Requested account does not match the authenticated Deriv account' });
  }
  
  if (platform === 'deriv' && config.executionMode && derivClient?.accountId) {
    const isDemoAccount = derivClient.accountId.startsWith('VRTC') || derivClient.accountId.startsWith('DOT');
    const isLiveAccount = derivClient.accountId.startsWith('CR') || derivClient.accountId.startsWith('ROT');
    if (config.executionMode === 'demo' && !isDemoAccount) return res.status(403).json({ error: 'Demo mode requires a Deriv demo account' });
    if (config.executionMode === 'live' && !isLiveAccount) return res.status(403).json({ error: 'Live mode requires a Deriv live account' });
  }
  
  try {
    // Create initial execution record with idempotency key
    const execution = store.beginExecution({ leg: 'leg1', accountId, symbol: config.symbol, contractType: 'CALL', stake: config.baseStake, idempotencyKey });
    store.updateExecution(execution.executionId, 'VALIDATING');
    
    engine = platform === 'deriv' ? new DerivEngine(derivClient!) : createEngine(platform);
    enginePlatform = platform;
    engine.start(config).catch((err: Error) => {
      store.addLog(`[System] Engine error: ${err.message}`, 'error');
      store.updateExecution(execution.executionId, 'FAILED', { error: err.message });
      store.stop('Engine error');
    });
    
    res.json({ ok: true, platform, executionId: execution.executionId, idempotencyKey });
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
  const { name, token, connectionType, copyType, copyRatio, maxStake, oauthAccountId } = req.body;
  if (!name || !token) return res.status(400).json({ error: 'Name and token are required' });
  const connType: 'pat' | 'oauth2' = connectionType || 'pat';
  const ct: CopyType = copyType || 'live_to_live';
  const fid = store.addFollower(name, token, connType, ct, copyRatio || 1.0, maxStake || 100.0, oauthAccountId);
  copyPool.sync();
  store.addLog(`[CopyPool] Added follower: ${name} (ID: ${fid})`, 'success');
  res.json({ status: 'SUCCESS', id: fid });
});

app.get('/api/copy-followers', (_req, res) => {
  const followers = store.getFollowers().map(f => ({
    id: f.id, name: f.name, connection_type: f.connection_type,
    token_masked: f.token.length > 10 ? f.token.slice(0, 6) + '...' + f.token.slice(-4) : '...',
    copy_type: f.copy_type, copy_ratio: f.copy_ratio, max_stake: f.max_stake,
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

app.patch('/api/copy-followers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid follower ID' });
  const f = store.getFollowers().find(x => x.id === id);
  if (!f) return res.status(404).json({ error: 'Follower not found' });
  const patch: any = {};
  const { copyType, copyRatio, maxStake, active } = req.body;
  if (copyType !== undefined) {
    const valid: CopyType[] = ['demo_to_demo', 'demo_to_live', 'live_to_live', 'live_to_demo'];
    if (!valid.includes(copyType)) return res.status(400).json({ error: 'Invalid copyType' });
    patch.copy_type = copyType;
  }
  if (copyRatio !== undefined) patch.copy_ratio = Math.max(0, parseFloat(copyRatio) || 1);
  if (maxStake !== undefined) patch.max_stake = Math.max(0, parseFloat(maxStake) || f.max_stake);
  if (active !== undefined) patch.active = active ? 1 : 0;
  const updated = store.updateFollower(id, patch);
  if (!updated) return res.status(404).json({ error: 'Follower not found' });
  copyPool.sync();
  store.addLog(`[CopyPool] Updated follower ${f.name} (ID: ${id})`, 'info');
  res.json({ status: 'SUCCESS', follower: store.getFollower(id) });
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
  const { masterSignalId, masterContractId, type, stake, duration, durationUnit, symbol, barrierDigit, barrierOffset } = req.body;
  if (!type || !stake || !symbol || masterContractId == null) {
    return res.status(400).json({ error: 'Missing trade params' });
  }
  try {
    await copyPool.replicationTrade(masterSignalId || 0, masterContractId, type, stake, duration, durationUnit, symbol, barrierDigit, barrierOffset);
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
  const { apiToken, oauthToken, accountId, copyType } = req.body;
  if (!apiToken && (!oauthToken || !accountId)) {
    return res.status(400).json({ error: 'Provide either apiToken or oauthToken + accountId' });
  }
  const name = apiToken ? apiToken.slice(0, 8) : (accountId || 'copy');
  const connType: 'pat' | 'oauth2' = apiToken ? 'pat' : 'oauth2';
  const token = apiToken || oauthToken!;
  const ct: CopyType = copyType || 'live_to_live';
  const fid = store.addFollower(name, token, connType, ct, 1.0, 100.0, connType === 'oauth2' ? accountId : undefined);
  copyPool.sync();
  const client = copyPool.getClient(fid);
  const account = client?.accountId || null;
  const balance = client?.balance || null;
  res.json({ ok: true, accountId: account, balance, followerId: fid });
});

app.post('/api/copy-trade', async (req, res) => {
  const { type, stake, duration, durationUnit, symbol, barrierDigit, barrierOffset } = req.body;
  if (!type || !stake || !symbol) return res.status(400).json({ error: 'Missing trade params' });
  try {
    await copyPool.replicationTrade(0, 0, type, stake, duration, durationUnit, symbol, barrierDigit, barrierOffset);
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
  const connected = derivClient?.connected ?? false;
  const hasOtp = derivClient?.hasOtpUrl ?? false;
  res.json({ valid: connected && hasOtp, connected, hasOtpUrl: hasOtp, accountId: derivClient?.accountId });
});

app.get('/', (_req, res) => {
  res.json({ status: 'ok', name: 'InvestPal Bot Engine', version: '1.0.0', running: store.isRunning, platform: enginePlatform, derivConnected: derivClient?.connected ?? false });
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', running: store.isRunning, platform: enginePlatform, connected: derivClient?.connected ?? null, emergencyStop: store.isEmergencyStopActive() });
});

app.get('/ready', (_req, res) => {
  const apiAuthConfigured = Boolean(process.env.API_AUTH_TOKEN);
  const databaseConfigured = Boolean(process.env.DATABASE_URL);
  const ready = process.env.NODE_ENV !== 'production' || (apiAuthConfigured && databaseConfigured);
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    apiAuthConfigured,
    databaseConfigured,
    executionJournal: Boolean(process.env.EXECUTION_JOURNAL_PATH || process.env.NODE_ENV !== 'production'),
    emergencyStop: store.isEmergencyStopActive(),
  });
});

app.post('/api/capital-protection/preview', (req, res) => {
  const input = req.body ?? {};
  const decision = evaluateCapitalProtection({
    realizedProfit: Number(input.realizedProfit ?? 0),
    unrealizedProfit: Number(input.unrealizedProfit ?? 0),
    exposure: Number(input.exposure ?? 0),
    balance: Number(input.balance ?? 0),
    equity: Number(input.equity ?? 0),
    protectedProfit: Number(input.protectedProfit ?? 0),
    maxExposure: Number(input.maxExposure ?? 250),
    protectedProfitThreshold: Number(input.protectedProfitThreshold ?? 80),
    maxDrawdown: Number(input.maxDrawdown ?? 150),
  });

  res.json(decision);
});

app.post('/api/jobs/submit', (req, res) => {
  const { executionId, accountId, symbol, stake, config } = req.body ?? {};
  if (!executionId || !accountId || !symbol || !stake || !config) {
    return res.status(400).json({ error: 'executionId, accountId, symbol, stake, and config are required' });
  }

  const job = createExecutionJob({ executionId, accountId, symbol, stake, config });
  executionQueue.enqueue(job);
  res.status(201).json({ jobId: job.id, status: 'PENDING' });
});

app.get('/api/jobs/:jobId', (req, res) => {
  const job = executionQueue.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/api/jobs/status/pending', (req, res) => {
  const pending = executionQueue.getPending();
  res.json({ count: pending.length, jobs: pending });
});

app.get('/api/jobs/status/processing', (req, res) => {
  const processing = executionQueue.getProcessing();
  res.json({ count: processing.length, jobs: processing });
});

// ── Live Authorization & Account Management ──────────────────────
app.post('/api/account/authorize-live', async (req, res) => {
  const correlationId = res.getHeader('X-Correlation-ID') as string;
  if (!derivClient?.accountId) return res.status(400).json({ error: 'No account connected' });
  
  const { confirm } = req.body;
  if (confirm !== true) {
    accountAuthz.revokeLiveAuthorization(derivClient.accountId);
    await auditLogger.logLiveAuthorizationAttempt(correlationId, derivClient.accountId, false, 'User did not confirm');
    return res.json({ authorized: false, message: 'Live trading authorization revoked' });
  }
  
  // Validate account type
  const authResult = await accountAuthz.authorizeAccount(derivClient.accountId, 'live', false);
  if (!authResult.authorized) {
    await auditLogger.logLiveAuthorizationAttempt(correlationId, derivClient.accountId, false, authResult.reason);
    return res.status(403).json({ error: authResult.reason });
  }
  
  // Record live authorization (30-min validity)
  await accountAuthz.recordLiveAuthorization(derivClient.accountId, true);
  await auditLogger.logLiveAuthorizationAttempt(correlationId, derivClient.accountId, true, 'User confirmed live trading');
  
  res.json({ authorized: true, accountId: derivClient.accountId, expiresIn: '30 minutes' });
});

app.get('/api/account/info', (req, res) => {
  if (!derivClient?.accountId) return res.status(400).json({ error: 'No account connected' });
  
  const isLiveAuthorized = accountAuthz.isLiveAuthConfirmed(derivClient.accountId);
  const isDemoAccount = derivClient.accountId.startsWith('VRTC') || derivClient.accountId.startsWith('DOT');
  const isLiveAccount = derivClient.accountId.startsWith('CR') || derivClient.accountId.startsWith('ROT');
  
  res.json({
    accountId: derivClient.accountId,
    accountType: isDemoAccount ? 'demo' : isLiveAccount ? 'live' : 'unknown',
    connected: derivClient.connected,
    liveAuthorizationActive: isLiveAuthorized,
  });
});

// ── Trade Journal Endpoints ────────────────────────────────────────
app.get('/api/trades', async (req, res) => {
  if (!derivClient?.accountId) return res.status(400).json({ error: 'No account connected' });
  
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const offset = Number(req.query.offset) || 0;
  const trades = await tradeJournal.getAccountTrades(derivClient.accountId, limit, offset);
  
  res.json({ trades, count: trades.length, limit, offset });
});

app.get('/api/trades/stats', async (req, res) => {
  if (!derivClient?.accountId) return res.status(400).json({ error: 'No account connected' });
  
  const stats = await tradeJournal.getAccountStats(derivClient.accountId);
  res.json(stats || {});
});

app.get('/api/trades/export', async (req, res) => {
  if (!derivClient?.accountId) return res.status(400).json({ error: 'No account connected' });
  
  const csv = await tradeJournal.exportTradesCSV(derivClient.accountId, 10000);
  if (!csv) return res.status(503).json({ error: 'Export unavailable' });
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=trades.csv');
  res.send(csv);
});

// ── Audit Log Endpoints ────────────────────────────────────────────
app.get('/api/audit-logs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const logs = auditLogger.getRecentLogs(limit);
  
  res.json({ logs, count: logs.length });
});

// ── Autonomous Trading Agent Routes ──
let currentAgent: AgentEngine | null = null;

app.post('/api/agent/start', async (req, res) => {
  if (currentAgent?.isRunning) return res.status(400).json({ error: 'Agent already running' });
  if (store.isEmergencyStopActive()) return res.status(423).json({ error: 'Trading is blocked by emergency stop' });
  const agentConfig: AgentConfig = req.body;
  if (!agentConfig.agentType || !agentConfig.profitTarget) {
    return res.status(400).json({ error: 'agentType and profitTarget required' });
  }
  if (!derivClient || !derivClient.hasOtpUrl) {
    return res.status(400).json({ error: 'Deriv connection not initialized' });
  }
  try {
    switch (agentConfig.agentType) {
      case 'strategy-rotator': currentAgent = new StrategyRotatorAgent(); break;
      case 'llm-agent': currentAgent = new LLMAgent(); break;
      case 'hybrid-agent': currentAgent = new HybridAgent(); break;
      default: return res.status(400).json({ error: `Unknown agent type: ${agentConfig.agentType}` });
    }
    currentAgent.start(agentConfig, derivClient).catch((err: Error) => {
      store.addLog(`[Agent] Error: ${err.message}`, 'error');
    });
    res.json({ ok: true, agentType: agentConfig.agentType });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent/stop', async (_req, res) => {
  if (currentAgent) await currentAgent.stop('User requested stop');
  currentAgent = null;
  res.json({ ok: true });
});

app.get('/api/agent/status', (_req, res) => {
  if (!currentAgent) return res.json({ isRunning: false, agentType: null });
  res.json(currentAgent.getStatus());
});

// ── WebSocket for real-time updates ──
// Reject unauthenticated WS connections BEFORE the upgrade completes.
server.on('upgrade', (req, socket, head) => {
  const wsUrl = new URL(req.url || '/', 'http://localhost');
  if (wsUrl.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  if (API_TOKEN && wsUrl.searchParams.get('token') !== API_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

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
  // Load persisted followers and reconnect
  store.loadFollowers();
  const fCount = store.getFollowers().length;
  if (fCount > 0) {
    console.log(`Loaded ${fCount} persisted follower(s), reconnecting...`);
    copyPool.sync();
  }
});

async function shutdown(signal: string) {
  clearInterval(reconciliationTimer);
  clearInterval(rateLimitCleanupTimer);
  if (engine) await engine.stop('Server shutdown');
  if (derivClient) derivClient.disconnect();
  copyPool.stopAll();
  if (postgresPersistence) await postgresPersistence.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
  console.log(`InvestPal shutdown requested by ${signal}`);
}

process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
