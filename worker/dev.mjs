// Local API for previewing the site: the worker on http://localhost:8797 with an in-memory D1, a fake RPC and a few sample bounties.
// Run: node dev.mjs
import { createServer } from 'node:http';
import worker from './src/index.js';
import { sqliteD1 } from './d1-sqlite.mjs';

const RPC = 'https://rpc.dev';
const env = { DB: sqliteD1(), SOL_RPC_URL: RPC, TOKEN_ADDRESS: '', TOKEN_DECIMALS: '6', POST_BURN: '25000', HOLD_EARLY: '500000', EARLY_MIN: '15', MIN_REWARD_SOL: '0.01', MAX_OPEN_PER_POSTER: '10', PAY_GRACE_HOURS: '72', SITE_URL: 'http://localhost:4202' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== RPC) return realFetch(url, init);
  const { method } = JSON.parse(init.body);
  const result = { getBalance: { value: 50e9 }, getTokenAccountsByOwner: { value: [] }, getLatestBlockhash: { value: { blockhash: '11111111111111111111111111111111' } } }[method] ?? null;
  return new Response(JSON.stringify({ result }));
};

const H = 3600000, now = Date.now();
const P1 = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', P2 = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const A = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH', B = 'CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq';
const db = env.DB;
await db.prepare("INSERT INTO wallets (addr, name) VALUES (?, 'deep-scout'), (?, 'ledger-hound')").bind(A, B).run();
const bounties = [
  [P1, 'Find every token this wallet launched in October and which ones rugged', 'Wallet: 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1\n\nList every pump.fun token it created in October 2026. For each: mint, launch time, peak market cap, and whether the dev sold more than 50% within an hour. CSV or a table.', 0.5, now - 5 * H, now + 30 * H],
  [P2, 'Write a launch thread for an MCP server, 8 posts', 'Eight posts for X introducing an MCP server for Solana token checks. Plain English, no hashtags, no emojis. First post must work on its own.', 0.2, now - 30 * H, now - 2 * H],
  [P1, 'Label 300 tweets about $SOL as bullish, bearish or neutral', 'I will send the CSV link to the first three hunters who ask in their entry. Return the same CSV with a label column.', 0.15, now - 2 * H, now + 46 * H],
  [P2, 'Telegram bot that pings when a wallet buys any token', 'Node or Python. Input: wallet address and a bot token. Output: message with the token, amount and Solscan link within 30 seconds of the buy.', 1.2, now - 1 * H, now + 70 * H],
  [P1, 'Translate a landing page into Spanish, Portuguese and Turkish', 'About 600 words. Keep product names in English. Return three markdown files.', 0.08, now - 3 * H, now + 20 * H],
];
for (const [poster, title, body, sol, created, deadline] of bounties) await db.prepare('INSERT INTO bounties (poster, title, body, reward, created, deadline) VALUES (?, ?, ?, ?, ?, ?)').bind(poster, title, body, Math.round(sol * 1e9), created, deadline).run();
await db.prepare("INSERT INTO submissions (bounty, hunter, body, created) VALUES (1, ?, 'csv attached', ?), (1, ?, 'table below', ?), (2, ?, 'thread', ?), (2, ?, 'thread v2', ?)").bind(A, now, B, now, A, now, B, now).run();
await db.prepare("UPDATE bounties SET status = 'paid', winner = ?, winner_sub = 4, paid_tx = ?, paid_at = ? WHERE id = 2").bind(B, '5'.repeat(88), now - H).run();

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request('http://localhost:8797' + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8797, () => console.log('WANTED dev API on http://localhost:8797'));
