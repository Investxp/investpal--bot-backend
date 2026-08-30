import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fork } from 'node:child_process';
import test from 'node:test';

test('paper API creates and settles a risk-gated execution', async (t) => {
  const port = 4200 + Math.floor(Math.random() * 100);
  const child = fork(new URL('../dist/index.js', import.meta.url), [], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), EXECUTION_JOURNAL_PATH: '', TRADING_CONTROL_PATH: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  t.after(() => child.kill('SIGTERM'));
  await once(child, 'spawn');
  let ready = false;
  for (let attempt = 0; attempt < 20 && !ready; attempt++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(ready, true);
  const config = { mode: 'rise-fall', symbol: 'R_100', baseStake: 1, duration: 5, durationUnit: 't', martingaleMultiplier: 2, takeProfit: 0, stopLoss: 0, selectedDigit: [], growthRate: 0, isHedgeMode: false, isAlternateMode: false, alternateFrequency: 0 };
  const openResponse = await fetch(`http://127.0.0.1:${port}/api/paper/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) });
  assert.equal(openResponse.status, 201);
  const open = await openResponse.json();
  const settleResponse = await fetch(`http://127.0.0.1:${port}/api/paper/settle/${open.execution.executionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ won: true, payout: 2.5 }) });
  assert.equal(settleResponse.status, 200);
  const settled = await settleResponse.json();
  assert.equal(settled.execution.state, 'RESULT');
  assert.equal(settled.execution.profit, 1.5);
});

test('emergency stop blocks and then allows paper execution after clearing', async (t) => {
  const port = 4300 + Math.floor(Math.random() * 100);
  const child = fork(new URL('../dist/index.js', import.meta.url), [], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), EXECUTION_JOURNAL_PATH: '', TRADING_CONTROL_PATH: '' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => child.kill('SIGTERM'));
  await once(child, 'spawn');
  for (let attempt = 0; attempt < 20; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  const stop = await fetch(`http://127.0.0.1:${port}/api/emergency-stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'integration test' }) });
  assert.equal(stop.status, 200);
  const blocked = await fetch(`http://127.0.0.1:${port}/api/paper/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'rise-fall', symbol: 'R_100', baseStake: 1, duration: 5, durationUnit: 't', martingaleMultiplier: 2, takeProfit: 0, stopLoss: 0, selectedDigit: [], growthRate: 0, isHedgeMode: false, isAlternateMode: false, alternateFrequency: 0 }) });
  assert.equal(blocked.status, 423);
  const clear = await fetch(`http://127.0.0.1:${port}/api/emergency-stop`, { method: 'DELETE' });
  assert.equal(clear.status, 200);
});

test('explicit paper and live modes cannot silently start broker execution', async (t) => {
  const port = 4400 + Math.floor(Math.random() * 100);
  const child = fork(new URL('../dist/index.js', import.meta.url), [], {
    env: { ...process.env, NODE_ENV: 'development', PORT: String(port), EXECUTION_JOURNAL_PATH: '', TRADING_CONTROL_PATH: '', ALLOW_LIVE_TRADING: 'false' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => child.kill('SIGTERM'));
  await once(child, 'spawn');
  for (let attempt = 0; attempt < 20; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  const base = { mode: 'rise-fall', symbol: 'R_100', baseStake: 1, duration: 5, durationUnit: 't', martingaleMultiplier: 2, takeProfit: 0, stopLoss: 0, selectedDigit: [], growthRate: 0, isHedgeMode: false, isAlternateMode: false, alternateFrequency: 0 };
  const paper = await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, executionMode: 'paper' }) });
  assert.equal(paper.status, 501);
  const live = await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base, executionMode: 'live' }) });
  assert.equal(live.status, 403);
});
