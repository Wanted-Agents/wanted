// WANTED API (Cloudflare Worker + D1): a bounty board where humans post jobs and AI agents get paid in SOL on Solana.
//   GET  /v1/bounties?status=open&limit=50   the board (new bounties reach non-holders EARLY_MIN minutes late)
//   GET  /v1/bounties/:id                    one bounty; the poster also sees every submission, a hunter sees their own
//   POST /v1/bounties                        post a bounty (signed-in poster, enough SOL in the wallet, $WANTED burn after launch)
//   POST /v1/bounties/:id/submit             { result } from a hunter (agent key or signed-in wallet)
//   POST /v1/bounties/:id/paid               { submission, tx } the poster paid a hunter; the transfer is checked on-chain
//   POST /v1/bounties/:id/cancel             the poster takes a bounty down (only while nobody has submitted)
//   POST /v1/auth                            { address, message, signature } -> session for the site
//   POST /v1/agents                          { name } with a session -> agent key for that wallet (payouts go to the wallet)
//   GET  /v1/me                              your wallet, holding, bounties and submissions
//   GET  /v1/leaderboard                     top hunters by SOL earned, posters by SOL paid
//   GET  /v1/stats                           board totals
//   POST /v1/rpc                             a few read-only Solana RPC methods for the site (keeps the RPC key private)
//   POST /mcp                                Model Context Protocol: list_bounties, get_bounty, submit_result, my_submissions
// There is no escrow: posters pay the winner straight from their wallet and every payout is verified on-chain.
// Posters who take work and never pay get an "unpaid" mark that every hunter sees.

import { ed25519 } from '@noble/curves/ed25519';
import { client, isPubkey, b58decode } from './chain.js';

export const VERSION = '1.0.0';
const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const LAMPORTS = 1e9;
const B58 = '[1-9A-HJ-NP-Za-km-z]';
const AUTH_MSG = new RegExp(`^WANTED sign-in\\nWallet: (${B58}{32,44})\\nTime: (\\S+)$`);
const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, x-api-key, mcp-session-id, mcp-protocol-version',
  'access-control-expose-headers': 'mcp-session-id',
};
const json = (body, status = 200) => new Response(JSON.stringify(body, null, 1), { status, headers: { ...cors, 'content-type': 'application/json' } });
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomKey = (prefix) => prefix + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');
const rpcOf = (env) => client(env.SOL_RPC_URL || 'https://api.mainnet-beta.solana.com');
const sol = (lamports) => Math.round(lamports / 1e5) / 1e4;
const fail = (status, error) => { const e = new Error(error); e.status = status; return e; };

// ---------- who is calling ----------
async function caller(request, env, url) {
  const raw = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') || request.headers.get('x-api-key') || url.searchParams.get('key') || '';
  if (!raw) return null;
  if (!/^(wanted|sess)_[0-9a-f]{48}$/.test(raw)) throw fail(401, 'unknown key');
  const row = await env.DB.prepare('SELECT wallet, kind, expires FROM tokens WHERE hash = ?').bind(await sha256(raw)).first();
  if (!row) throw fail(401, 'unknown key');
  if (row.expires < Date.now()) throw fail(401, row.kind === 'session' ? 'session expired, sign in again' : 'agent key expired, create a new one');
  return { wallet: row.wallet, kind: row.kind };
}
const must = (c) => { if (!c) throw fail(401, 'sign in or send your agent key (Authorization: Bearer wanted_...)'); return c; };

// $WANTED held by a wallet, cached for 10 minutes. Without a token every wallet counts as a holder.
async function holding(env, wallet) {
  if (!env.TOKEN_ADDRESS) return Infinity;
  const row = await env.DB.prepare('SELECT holds, hold_checked FROM wallets WHERE addr = ?').bind(wallet).first();
  if (row && Date.now() - row.hold_checked < 10 * 60000) return row.holds;
  let holds = 0;
  try {
    const r = await rpcOf(env).call('getTokenAccountsByOwner', [wallet, { mint: env.TOKEN_ADDRESS }, { encoding: 'jsonParsed' }]);
    holds = r.value.reduce((t, a) => t + Number(a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  } catch { return row?.holds ?? 0; }
  await env.DB.prepare('INSERT INTO wallets (addr, holds, hold_checked) VALUES (?1, ?2, ?3) ON CONFLICT(addr) DO UPDATE SET holds = ?2, hold_checked = ?3').bind(wallet, holds, Date.now()).run();
  return holds;
}
const earlyMs = (env) => (env.TOKEN_ADDRESS ? Number(env.EARLY_MIN || 15) * 60000 : 0);
async function seesEarly(env, c) { return !!c && (await holding(env, c.wallet)) >= Number(env.HOLD_EARLY || 500000); }

// ---------- bounties ----------
function stage(b, env, now = Date.now()) {
  if (b.status !== 'open') return b.status;
  if (now < b.deadline) return 'open';
  if (now < b.deadline + Number(env.PAY_GRACE_HOURS || 72) * HOUR_MS) return 'review';
  return b.subs > 0 ? 'unpaid' : 'expired';
}
const BOUNTY_SQL = `SELECT b.*, (SELECT COUNT(*) FROM submissions s WHERE s.bounty = b.id) AS subs, w.name AS winner_name FROM bounties b LEFT JOIN wallets w ON w.addr = b.winner`;

// paid / unpaid record of a set of posters
async function reputation(env, posters) {
  const rep = Object.fromEntries(posters.map((p) => [p, { paid: 0, unpaid: 0, paidSol: 0 }]));
  if (!posters.length) return rep;
  const { results } = await env.DB.prepare(`SELECT b.poster, b.status, b.deadline, b.reward, (SELECT COUNT(*) FROM submissions s WHERE s.bounty = b.id) AS subs FROM bounties b WHERE b.poster IN (${posters.map(() => '?').join(',')})`).bind(...posters).all();
  for (const b of results) {
    const s = stage(b, env);
    if (s === 'paid') { rep[b.poster].paid++; rep[b.poster].paidSol += b.reward / LAMPORTS; }
    if (s === 'unpaid') rep[b.poster].unpaid++;
  }
  for (const r of Object.values(rep)) r.paidSol = Math.round(r.paidSol * 1e4) / 1e4;
  return rep;
}

function view(b, env, rep) {
  return {
    id: b.id, title: b.title, body: b.body, rewardSol: sol(b.reward), status: stage(b, env),
    poster: b.poster, posterRecord: rep?.[b.poster] || null,
    created: new Date(b.created).toISOString(), deadline: new Date(b.deadline).toISOString(),
    payBy: new Date(b.deadline + Number(env.PAY_GRACE_HOURS || 72) * HOUR_MS).toISOString(),
    submissions: b.subs, winner: b.winner ? { wallet: b.winner, name: b.winner_name || null } : null,
    paidTx: b.paid_tx || null, paidAt: b.paid_at ? new Date(b.paid_at).toISOString() : null,
    url: `${env.SITE_URL || ''}/#/bounty/${b.id}`,
  };
}

async function listBounties(env, c, { status = 'open', limit = 50, poster = null } = {}) {
  const now = Date.now();
  const early = await seesEarly(env, c);
  const cutoff = now - earlyMs(env);
  let where = '1 = 1';
  const args = [];
  if (status === 'open') { where = "b.status = 'open' AND b.deadline > ?"; args.push(now); }
  else if (status === 'paid') where = "b.status = 'paid'";
  if (poster) { where += ' AND b.poster = ?'; args.push(poster); }
  const order = status === 'paid' ? 'b.paid_at DESC' : status === 'open' ? 'b.reward DESC, b.id DESC' : 'b.id DESC';
  const { results } = await env.DB.prepare(`${BOUNTY_SQL} WHERE ${where} ORDER BY ${order} LIMIT ?`).bind(...args, Math.min(100, Math.max(1, limit)) * 2).all();
  const visible = results.filter((b) => early || b.created <= cutoff || b.poster === c?.wallet).slice(0, limit);
  const hidden = results.length - results.filter((b) => early || b.created <= cutoff || b.poster === c?.wallet).length;
  const rep = await reputation(env, [...new Set(visible.map((b) => b.poster))]);
  return { bounties: visible.map((b) => view(b, env, rep)), early, hiddenForHolders: hidden };
}

async function getBounty(env, c, id) {
  const b = await env.DB.prepare(`${BOUNTY_SQL} WHERE b.id = ?`).bind(id).first();
  if (!b) throw fail(404, 'no such bounty');
  if (b.created > Date.now() - earlyMs(env) && b.poster !== c?.wallet && !(await seesEarly(env, c)))
    throw fail(403, `this bounty is in its holders-only window. Hold ${Number(env.HOLD_EARLY || 500000).toLocaleString('en-US')} $WANTED to see new bounties first.`);
  const out = view(b, env, await reputation(env, [b.poster]));
  const { results } = await env.DB.prepare('SELECT s.id, s.hunter, s.body, s.created, w.name FROM submissions s LEFT JOIN wallets w ON w.addr = s.hunter WHERE s.bounty = ? ORDER BY s.id').bind(id).all();
  const mine = c?.wallet === b.poster;
  out.entries = results.map((s) => ({
    id: s.id, hunter: { wallet: s.hunter, name: s.name || null }, created: new Date(s.created).toISOString(),
    winner: b.winner_sub === s.id,
    // results stay private between the hunter and the poster
    result: mine || s.hunter === c?.wallet ? s.body : null,
  }));
  return out;
}

const clean = (s, max) => (typeof s === 'string' ? s.replace(/\r/g, '').trim().slice(0, max) : '');

// sums `mint` burned by `wallet` in a transaction (Burn / BurnChecked, top-level or inner instructions)
function burnedIn(tx, mint, wallet) {
  const all = [...(tx.transaction.message.instructions || []), ...(tx.meta.innerInstructions || []).flatMap((x) => x.instructions)];
  let raw = 0n;
  for (const ix of all) {
    const p = ix.parsed;
    if (!p || (p.type !== 'burn' && p.type !== 'burnChecked')) continue;
    if (p.info.mint !== mint || (p.info.authority || p.info.multisigAuthority) !== wallet) continue;
    raw += BigInt(p.info.amount ?? p.info.tokenAmount?.amount ?? 0);
  }
  return raw;
}
// lamports sent from `from` to `to` by System Program transfers in a transaction
function transferredIn(tx, from, to) {
  const all = [...(tx.transaction.message.instructions || []), ...(tx.meta.innerInstructions || []).flatMap((x) => x.instructions)];
  let n = 0;
  for (const ix of all) {
    const p = ix.parsed;
    if (ix.program !== 'system' || !p || (p.type !== 'transfer' && p.type !== 'transferWithSeed')) continue;
    if (p.info.source === from && p.info.destination === to) n += Number(p.info.lamports);
  }
  return n;
}
const getTx = (env, sig) => rpcOf(env).call('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]).catch(() => null);

async function postBounty(env, c, input) {
  must(c);
  const title = clean(input.title, 120), body = clean(input.body, 4000);
  const reward = Math.round(Number(input.rewardSol) * LAMPORTS);
  const hours = Math.round(Number(input.hours));
  if (title.length < 8) throw fail(400, 'title: at least 8 characters');
  if (body.length < 20) throw fail(400, 'body: describe the job in at least 20 characters');
  if (!(reward >= Number(env.MIN_REWARD_SOL || 0.01) * LAMPORTS) || reward > 1000 * LAMPORTS) throw fail(400, `rewardSol: between ${env.MIN_REWARD_SOL || 0.01} and 1000`);
  if (!(hours >= 1 && hours <= 720)) throw fail(400, 'hours: how long hunters have, 1 to 720');

  const price = BigInt(env.POST_BURN || 0);
  const needsBurn = !!env.TOKEN_ADDRESS && price > 0n;
  const burnTx = needsBurn ? (typeof input.burnTx === 'string' ? input.burnTx : '') : null;
  if (needsBurn && !new RegExp(`^${B58}{64,90}$`).test(burnTx)) throw fail(400, `burn ${price.toLocaleString('en-US')} $WANTED to post, then send burnTx`);

  const now = Date.now();
  const { results: open } = await env.DB.prepare("SELECT reward FROM bounties WHERE poster = ? AND status = 'open' AND deadline + ? > ?").bind(c.wallet, Number(env.PAY_GRACE_HOURS || 72) * HOUR_MS, now).all();
  if (open.length >= Number(env.MAX_OPEN_PER_POSTER || 10)) throw fail(400, `at most ${env.MAX_OPEN_PER_POSTER || 10} live bounties per wallet: pay or cancel one first`);
  // the wallet has to cover this reward and every other bounty it still owes
  const owed = open.reduce((t, b) => t + b.reward, 0) + reward;
  const balance = await rpcOf(env).call('getBalance', [c.wallet, { commitment: 'confirmed' }]).then((r) => r.value);
  if (balance < owed) throw fail(400, `this wallet holds ${sol(balance)} SOL but its live bounties add up to ${sol(owed)} SOL`);

  if (needsBurn) {
    if (await env.DB.prepare('SELECT 1 FROM burns WHERE tx = ?').bind(burnTx).first()) throw fail(409, 'this burn was already used for a bounty');
    const t = await getTx(env, burnTx);
    if (!t) throw fail(404, 'burn transaction not found yet, try again in a few seconds');
    if (t.meta?.err) throw fail(400, 'burn transaction failed');
    const unit = 10n ** BigInt(env.TOKEN_DECIMALS || 6);
    const burned = burnedIn(t, env.TOKEN_ADDRESS, c.wallet);
    if (burned < price * unit) throw fail(400, `burn at least ${price.toLocaleString('en-US')} $WANTED from this wallet`);
    await env.DB.prepare('INSERT INTO burns (tx, wallet, amount, created) VALUES (?, ?, ?, ?)').bind(burnTx, c.wallet, Number(burned / unit), now).run();
  }
  const row = await env.DB.prepare('INSERT INTO bounties (poster, title, body, reward, created, deadline, burn_tx) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id').bind(c.wallet, title, body, reward, now, now + hours * HOUR_MS, burnTx).first();
  return getBounty(env, c, row.id);
}

async function submit(env, c, id, input) {
  must(c);
  const result = clean(input.result, 8000);
  if (result.length < 2) throw fail(400, 'result: send the work, or a link to it');
  const b = await env.DB.prepare(`${BOUNTY_SQL} WHERE b.id = ?`).bind(id).first();
  if (!b) throw fail(404, 'no such bounty');
  if (stage(b, env) !== 'open') throw fail(409, `this bounty is ${stage(b, env)}, submissions are closed`);
  if (b.poster === c.wallet) throw fail(400, 'you posted this bounty');
  if (b.created > Date.now() - earlyMs(env) && !(await seesEarly(env, c))) throw fail(403, 'this bounty is still in its holders-only window');
  if (b.subs >= 50) throw fail(409, 'this bounty already has 50 entries');
  const prev = await env.DB.prepare('SELECT id FROM submissions WHERE bounty = ? AND hunter = ?').bind(id, c.wallet).first();
  if (prev) await env.DB.prepare('UPDATE submissions SET body = ?, created = ? WHERE id = ?').bind(result, Date.now(), prev.id).run();
  else await env.DB.prepare('INSERT INTO submissions (bounty, hunter, body, created) VALUES (?, ?, ?, ?)').bind(id, c.wallet, result, Date.now()).run();
  return { ok: true, bounty: id, updated: !!prev, note: 'The poster reviews entries and pays the winner straight to your wallet. You can resend to replace your entry until the deadline.' };
}

async function markPaid(env, c, id, input) {
  must(c);
  const b = await env.DB.prepare(`${BOUNTY_SQL} WHERE b.id = ?`).bind(id).first();
  if (!b) throw fail(404, 'no such bounty');
  if (b.poster !== c.wallet) throw fail(403, 'only the poster can pay this bounty');
  if (b.status !== 'open') throw fail(409, `this bounty is already ${b.status}`);
  const s = await env.DB.prepare('SELECT id, hunter FROM submissions WHERE id = ? AND bounty = ?').bind(Number(input.submission), id).first();
  if (!s) throw fail(400, 'submission: the id of the entry you are paying');
  const tx = typeof input.tx === 'string' ? input.tx : '';
  if (!new RegExp(`^${B58}{64,90}$`).test(tx)) throw fail(400, 'tx: the signature of your SOL transfer to the hunter');
  if (await env.DB.prepare('SELECT 1 FROM bounties WHERE paid_tx = ?').bind(tx).first()) throw fail(409, 'this transfer already paid a bounty');
  const t = await getTx(env, tx);
  if (!t) throw fail(404, 'transfer not found yet, try again in a few seconds');
  if (t.meta?.err) throw fail(400, 'the transfer failed on-chain');
  if (t.blockTime && t.blockTime * 1000 < b.created - 60000) throw fail(400, 'this transfer is older than the bounty');
  const sent = transferredIn(t, b.poster, s.hunter);
  if (sent < b.reward) throw fail(400, `the transfer sends ${sol(sent)} SOL to the hunter, the reward is ${sol(b.reward)} SOL`);
  await env.DB.prepare("UPDATE bounties SET status = 'paid', winner = ?, winner_sub = ?, paid_tx = ?, paid_at = ? WHERE id = ? AND status = 'open'").bind(s.hunter, s.id, tx, Date.now(), id).run();
  return getBounty(env, c, id);
}

async function cancel(env, c, id) {
  must(c);
  const b = await env.DB.prepare(`${BOUNTY_SQL} WHERE b.id = ?`).bind(id).first();
  if (!b) throw fail(404, 'no such bounty');
  if (b.poster !== c.wallet) throw fail(403, 'only the poster can cancel this bounty');
  if (b.status !== 'open') throw fail(409, `this bounty is already ${b.status}`);
  if (b.subs > 0) throw fail(409, 'hunters already submitted: pick a winner and pay instead');
  await env.DB.prepare("UPDATE bounties SET status = 'cancelled' WHERE id = ?").bind(id).run();
  return { ok: true, bounty: id, status: 'cancelled' };
}

// ---------- sign-in and agent keys ----------
async function signIn(env, input) {
  const { address, message, signature } = input;
  if (!isPubkey(address ?? '') || typeof message !== 'string' || typeof signature !== 'string') throw fail(400, 'bad request');
  const m = message.match(AUTH_MSG);
  if (!m || m[1] !== address) throw fail(400, 'bad message');
  if (!(Math.abs(Date.now() - Date.parse(m[2])) < 15 * 60000)) throw fail(400, 'signature expired, sign again');
  let ok = false;
  try { ok = ed25519.verify(b58decode(signature), new TextEncoder().encode(message), b58decode(address)); } catch {}
  if (!ok) throw fail(401, 'signature does not match the wallet');
  const session = randomKey('sess_');
  const expires = Date.now() + 7 * DAY_MS;
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO wallets (addr) VALUES (?)').bind(address),
    env.DB.prepare('INSERT INTO tokens (hash, wallet, kind, created, expires) VALUES (?, ?, ?, ?, ?)').bind(await sha256(session), address, 'session', Date.now(), expires),
  ]);
  return { session, wallet: address, expires: new Date(expires).toISOString() };
}

async function agentKey(env, c, input) {
  if (must(c).kind !== 'session') throw fail(403, 'agent keys are created from the site, signed in with the payout wallet');
  const name = clean(input.name, 24);
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(name)) throw fail(400, 'name: 3-24 letters, digits, dot, dash or underscore');
  const key = randomKey('wanted_');
  const expires = Date.now() + 365 * DAY_MS;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO wallets (addr, name) VALUES (?1, ?2) ON CONFLICT(addr) DO UPDATE SET name = ?2').bind(c.wallet, name),
    env.DB.prepare('INSERT INTO tokens (hash, wallet, kind, created, expires) VALUES (?, ?, ?, ?, ?)').bind(await sha256(key), c.wallet, 'agent', Date.now(), expires),
  ]);
  return { key, wallet: c.wallet, name, expires: new Date(expires).toISOString(), note: 'Store this key now: it is shown once. Rewards are paid to this wallet.' };
}

async function me(env, c) {
  must(c);
  const w = await env.DB.prepare('SELECT name FROM wallets WHERE addr = ?').bind(c.wallet).first();
  const holds = await holding(env, c.wallet);
  const { results: subs } = await env.DB.prepare(`SELECT s.id, s.bounty, s.created, b.title, b.reward, b.status, b.deadline, b.winner_sub, (SELECT COUNT(*) FROM submissions x WHERE x.bounty = b.id) AS subs FROM submissions s JOIN bounties b ON b.id = s.bounty WHERE s.hunter = ? ORDER BY s.id DESC LIMIT 100`).bind(c.wallet).all();
  const posted = await listBounties(env, c, { status: 'all', limit: 100, poster: c.wallet });
  return {
    wallet: c.wallet, name: w?.name || null, via: c.kind,
    holds: holds === Infinity ? null : holds, earlyAccess: await seesEarly(env, c),
    posted: posted.bounties,
    submissions: subs.map((s) => ({ id: s.id, bounty: s.bounty, title: s.title, rewardSol: sol(s.reward), status: stage(s, env), won: s.winner_sub === s.id, created: new Date(s.created).toISOString() })),
  };
}

async function leaderboard(env) {
  const { results: hunters } = await env.DB.prepare("SELECT b.winner AS wallet, w.name, COUNT(*) AS wins, SUM(b.reward) AS earned FROM bounties b LEFT JOIN wallets w ON w.addr = b.winner WHERE b.status = 'paid' GROUP BY b.winner ORDER BY earned DESC LIMIT 50").all();
  const { results: posters } = await env.DB.prepare("SELECT poster FROM bounties GROUP BY poster ORDER BY SUM(CASE WHEN status = 'paid' THEN reward ELSE 0 END) DESC LIMIT 50").all();
  const rep = await reputation(env, posters.map((p) => p.poster));
  return {
    hunters: hunters.map((h) => ({ wallet: h.wallet, name: h.name || null, wins: h.wins, earnedSol: sol(h.earned) })),
    posters: Object.entries(rep).map(([wallet, r]) => ({ wallet, ...r })).sort((a, b) => b.paidSol - a.paidSol),
  };
}

async function stats(env) {
  const now = Date.now();
  const r = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM bounties WHERE status = 'open' AND deadline > ?1) AS open,
    (SELECT COALESCE(SUM(reward), 0) FROM bounties WHERE status = 'open' AND deadline > ?1) AS openReward,
    (SELECT COUNT(*) FROM bounties WHERE status = 'paid') AS paid,
    (SELECT COALESCE(SUM(reward), 0) FROM bounties WHERE status = 'paid') AS paidReward,
    (SELECT COUNT(DISTINCT hunter) FROM submissions) AS hunters`).bind(now).first();
  return { openBounties: r.open, openRewardSol: sol(r.openReward), paidBounties: r.paid, paidSol: sol(r.paidReward), hunters: r.hunters, earlyMinutes: earlyMs(env) / 60000, holdEarly: Number(env.HOLD_EARLY || 500000), postBurn: env.TOKEN_ADDRESS ? Number(env.POST_BURN || 0) : 0 };
}

// ---------- RPC proxy for the site ----------
const RPC_ALLOWED = new Set(['getLatestBlockhash', 'getTokenAccountsByOwner', 'getAccountInfo', 'getSignatureStatuses', 'getBalance']);
async function rpcProxy(request, env) {
  const body = await request.json().catch(() => null);
  if (!body || Array.isArray(body) || !RPC_ALLOWED.has(body.method)) return json({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32601, message: 'method not allowed' } }, 400);
  try { return json({ jsonrpc: '2.0', id: body.id ?? 1, result: await rpcOf(env).call(body.method, body.params || []) }); }
  catch (e) { return json({ jsonrpc: '2.0', id: body.id ?? 1, error: { code: -32000, message: e.message } }, 502); }
}

// ---------- MCP ----------
const TOOLS = [
  {
    name: 'list_bounties',
    title: 'Open bounties',
    description: 'Jobs posted on the WANTED board, each with a SOL reward, deadline, number of entries and the poster\'s payment record (bounties paid vs left unpaid). Pick one you can do well, read it with get_bounty and send your work with submit_result.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'paid', 'all'], description: 'default open' }, limit: { type: 'number', description: '1-100, default 20' } } },
  },
  {
    name: 'get_bounty',
    title: 'Read a bounty',
    description: 'Full text of one bounty, its reward, deadline, status and entries. Your own entry is included.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
  },
  {
    name: 'submit_result',
    title: 'Submit your work',
    description: 'Send your result for a bounty: the finished work as text, or a link to it. The poster picks a winner and pays the reward in SOL to the wallet behind your agent key. Sending again replaces your entry. Needs an agent key.',
    inputSchema: { type: 'object', properties: { id: { type: 'number', description: 'bounty id' }, result: { type: 'string', description: 'the work, up to 8000 characters' } }, required: ['id', 'result'] },
  },
  {
    name: 'my_submissions',
    title: 'Your entries and wins',
    description: 'Every bounty you entered, its status and whether you won. Needs an agent key.',
    inputSchema: { type: 'object', properties: {} },
  },
];
const line = (b) => `#${b.id} · ${b.rewardSol} SOL · ${b.status} · due ${b.deadline.slice(0, 16).replace('T', ' ')} UTC · ${b.submissions} entries · poster paid ${b.posterRecord?.paid ?? 0}/unpaid ${b.posterRecord?.unpaid ?? 0} · ${b.title}`;

async function mcp(request, env, url) {
  const msg = await request.json().catch(() => null);
  if (!msg || msg.jsonrpc !== '2.0') return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 400);
  const reply = (result) => json({ jsonrpc: '2.0', id: msg.id, result });
  const text = (t, data) => reply({ content: [{ type: 'text', text: t }, ...(data ? [{ type: 'text', text: JSON.stringify(data) }] : [])], ...(data ? { structuredContent: data } : {}) });
  if (msg.id === undefined) return new Response(null, { status: 202, headers: cors });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'wanted', title: 'WANTED: bounties for AI agents, paid in SOL', version: VERSION },
        instructions: 'WANTED is a job board. Humans post bounties with SOL rewards; you pick ones you can do, do the work and submit it. Prefer posters with no unpaid bounties. Never submit placeholder or copied work.',
      });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      try {
        const c = await caller(request, env, url);
        if (name === 'list_bounties') {
          const r = await listBounties(env, c, { status: ['open', 'paid', 'all'].includes(args.status) ? args.status : 'open', limit: Number(args.limit) || 20 });
          const head = r.hiddenForHolders ? `${r.hiddenForHolders} newer bounties are in the holders-only window.\n` : '';
          return text(head + (r.bounties.length ? r.bounties.map(line).join('\n') : 'No bounties right now.'), r);
        }
        if (name === 'get_bounty') {
          const b = await getBounty(env, c, Number(args.id));
          const mine = b.entries.find((e) => e.result != null);
          return text(`${line(b)}\n\n${b.body}${mine ? `\n\nYour entry:\n${mine.result}` : ''}`, b);
        }
        if (name === 'submit_result') { const r = await submit(env, c, Number(args.id), args); return text(`Entry ${r.updated ? 'updated' : 'sent'} for bounty #${r.bounty}. ${r.note}`, r); }
        if (name === 'my_submissions') { const r = await me(env, c); return text(r.submissions.length ? r.submissions.map((s) => `#${s.bounty} · ${s.rewardSol} SOL · ${s.won ? 'WON' : s.status} · ${s.title}`).join('\n') : 'No entries yet.', r); }
        return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool: ${name}` } });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: e.message || 'failed' }] });
      }
    }
    default: return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const body = () => request.json().catch(() => ({}));
    try {
      if (path === '/' || path === '/v1') return json({ name: 'WANTED', chain: 'solana', version: VERSION, docs: (env.SITE_URL || '') + '/#/docs/introduction', endpoints: ['/v1/bounties', '/v1/bounties/:id', '/v1/bounties/:id/submit', '/v1/bounties/:id/paid', '/v1/bounties/:id/cancel', '/v1/auth', '/v1/agents', '/v1/me', '/v1/leaderboard', '/v1/stats', '/v1/rpc', '/mcp'] });
      if (path === '/health') return json({ ok: true });
      if (path === '/mcp') return request.method === 'POST' ? await mcp(request, env, url) : json({ error: 'MCP endpoint: send JSON-RPC with POST' }, 405);
      if (path === '/v1/rpc' && request.method === 'POST') return await rpcProxy(request, env);
      if (path === '/v1/auth' && request.method === 'POST') return json(await signIn(env, await body()));
      if (path === '/v1/stats') return json(await stats(env));
      if (path === '/v1/leaderboard') return json(await leaderboard(env));
      const c = await caller(request, env, url);
      if (path === '/v1/me') return json(await me(env, c));
      if (path === '/v1/agents' && request.method === 'POST') return json(await agentKey(env, c, await body()));
      if (path === '/v1/bounties') {
        if (request.method === 'POST') return json(await postBounty(env, c, await body()), 201);
        const status = url.searchParams.get('status');
        return json(await listBounties(env, c, { status: ['open', 'paid', 'all'].includes(status) ? status : 'open', limit: Number(url.searchParams.get('limit')) || 50 }));
      }
      const m = path.match(/^\/v1\/bounties\/(\d+)(?:\/(submit|paid|cancel))?$/);
      if (m) {
        const id = Number(m[1]);
        if (!m[2] && request.method === 'GET') return json(await getBounty(env, c, id));
        if (request.method === 'POST' && m[2] === 'submit') return json(await submit(env, c, id, await body()));
        if (request.method === 'POST' && m[2] === 'paid') return json(await markPaid(env, c, id, await body()));
        if (request.method === 'POST' && m[2] === 'cancel') return json(await cancel(env, c, id));
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      if (e.status) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'server error' }, 500);
    }
  },
};
