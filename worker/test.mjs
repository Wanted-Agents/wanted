// Exercises the worker in Node: node:sqlite stands in for D1 and the Solana RPC is faked (balances, burns, transfers, holdings).
// Run: node test.mjs
import { ed25519 } from '@noble/curves/ed25519';
import worker from './src/index.js';
import { sqliteD1 } from './d1-sqlite.mjs';
import { b58encode } from './src/chain.js';

const RPC = 'https://rpc.test';
const MINT = 'WantedTestMint11111111111111111111111111111';
const env = { DB: sqliteD1(), SOL_RPC_URL: RPC, TOKEN_ADDRESS: '', TOKEN_DECIMALS: '6', POST_BURN: '25000', HOLD_EARLY: '500000', EARLY_MIN: '15', MIN_REWARD_SOL: '0.01', MAX_OPEN_PER_POSTER: '3', PAY_GRACE_HOURS: '72', SITE_URL: 'https://wanted.test' };

// ---- fake chain ----
const balances = {}, holdings = {}, txs = {};
globalThis.fetch = async (url, init) => {
  if (String(url) !== RPC) throw new Error('unexpected fetch ' + url);
  const { method, params } = JSON.parse(init.body);
  const result = {
    getBalance: () => ({ value: balances[params[0]] ?? 0 }),
    getTransaction: () => txs[params[0]] ?? null,
    getTokenAccountsByOwner: () => ({ value: holdings[params[0]] ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: holdings[params[0]] } } } } } }] : [] }),
    getLatestBlockhash: () => ({ value: { blockhash: '11111111111111111111111111111111' } }),
  }[method]?.();
  return new Response(JSON.stringify(result === undefined ? { error: { message: 'nope' } } : { result }));
};
const sig = (c) => c.repeat(88);
const transferTx = (from, to, sol, blockTime = Math.floor(Date.now() / 1000)) => ({ blockTime, meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: from, destination: to, lamports: Math.round(sol * 1e9) } } }] } } });
const burnTx = (authority, tokens) => ({ meta: { err: null, innerInstructions: [] }, transaction: { message: { instructions: [{ parsed: { type: 'burnChecked', info: { mint: MINT, authority, tokenAmount: { amount: String(BigInt(tokens) * 10n ** 6n) } } } }] } } });

const wallet = () => { const sk = ed25519.utils.randomPrivateKey(); return { sk, address: b58encode(ed25519.getPublicKey(sk)) }; };
const call = async (path, init = {}, token) => {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) };
  const res = await worker.fetch(new Request('https://api.wanted.test' + path, { ...init, headers }), env);
  const text = await res.text();
  return [res.status, text ? JSON.parse(text) : null];
};
const post = (path, body, token) => call(path, { method: 'POST', body: JSON.stringify(body) }, token);
const signIn = async (w) => {
  const message = `WANTED sign-in\nWallet: ${w.address}\nTime: ${new Date().toISOString()}`;
  const signature = b58encode(ed25519.sign(new TextEncoder().encode(message), w.sk));
  return post('/v1/auth', { address: w.address, message, signature });
};
const mcp = (method, params, token) => post('/mcp', { jsonrpc: '2.0', id: 1, method, params }, token);
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ': ' + String(JSON.stringify(detail)).slice(0, 400)}`); };

// ---- sign-in ----
const poster = wallet(), hunter = wallet(), other = wallet(), stranger = wallet();
const [, root] = await call('/');
check('root describes the API', root.name === 'WANTED' && root.endpoints.includes('/mcp'), root);
const [sa, s1] = await signIn(poster);
check('poster signs in', sa === 200 && s1.session.startsWith('sess_'), s1);
const ps = s1.session;
const forged = await post('/v1/auth', { address: poster.address, message: `WANTED sign-in\nWallet: ${poster.address}\nTime: ${new Date().toISOString()}`, signature: b58encode(ed25519.sign(new TextEncoder().encode('x'), hunter.sk)) });
check('forged signature rejected', forged[0] === 401, forged);
const stale = `WANTED sign-in\nWallet: ${poster.address}\nTime: 2020-01-01T00:00:00Z`;
check('old signature rejected', (await post('/v1/auth', { address: poster.address, message: stale, signature: b58encode(ed25519.sign(new TextEncoder().encode(stale), poster.sk)) }))[0] === 400);
const hs = (await signIn(hunter))[1].session;
const os = (await signIn(other))[1].session;

// ---- agent keys ----
const [ka, k1] = await post('/v1/agents', { name: 'deep-scout' }, hs);
check('agent key from a session', ka === 200 && k1.key.startsWith('wanted_') && k1.wallet === hunter.address, k1);
const hk = k1.key;
check('agent key cannot mint keys', (await post('/v1/agents', { name: 'x-agent' }, hk))[0] === 403);
check('bad name', (await post('/v1/agents', { name: 'a b' }, hs))[0] === 400);
check('unknown key', (await call('/v1/me', {}, 'wanted_' + '0'.repeat(48)))[0] === 401);

// ---- posting ----
const job = { title: 'Find 3 rugs launched today', body: 'List three pump.fun tokens launched today that rugged, with the mint and the rug transaction for each.', rewardSol: 0.5, hours: 24 };
check('posting needs sign-in', (await post('/v1/bounties', job))[0] === 401);
balances[poster.address] = 0.2e9;
const [pb, broke] = await post('/v1/bounties', job, ps);
check('poster must hold the reward', pb === 400 && /holds 0.2 SOL/.test(broke.error), broke);
balances[poster.address] = 1.2e9;
const [p1, b1] = await post('/v1/bounties', job, ps);
check('bounty posted', p1 === 201 && b1.id === 1 && b1.rewardSol === 0.5 && b1.status === 'open' && b1.url === 'https://wanted.test/#/bounty/1', b1);
const [p2, broke2] = await post('/v1/bounties', { ...job, rewardSol: 0.8 }, ps);
check('balance must cover all live bounties', p2 === 400 && /add up to 1.3 SOL/.test(broke2.error), broke2);
check('short title', (await post('/v1/bounties', { ...job, title: 'x' }, ps))[0] === 400);
check('tiny reward', (await post('/v1/bounties', { ...job, rewardSol: 0.001 }, ps))[0] === 400);
const [, b2] = await post('/v1/bounties', { ...job, title: 'Write a launch thread for $WANTED', rewardSol: 0.1 }, ps);

// ---- board ----
const [, list] = await call('/v1/bounties');
check('public board lists open bounties by reward', list.bounties.length === 2 && list.bounties[0].id === 1 && list.bounties[0].posterRecord.paid === 0, list);

// ---- submissions ----
check('poster cannot enter own bounty', (await post('/v1/bounties/1/submit', { result: 'mine' }, ps))[0] === 400);
const [sb, sub] = await post('/v1/bounties/1/submit', { result: 'MINT1 rug tx A; MINT2 rug tx B; MINT3 rug tx C' }, hk);
check('hunter submits with agent key', sb === 200 && sub.updated === false, sub);
const [, again] = await post('/v1/bounties/1/submit', { result: 'v2: MINT1, MINT2, MINT3 with txs' }, hk);
check('resubmitting replaces the entry', again.updated === true, again);
await post('/v1/bounties/1/submit', { result: 'other answer' }, os);
const [, asPoster] = await call('/v1/bounties/1', {}, ps);
check('poster sees all results', asPoster.entries.length === 2 && asPoster.entries[0].result.startsWith('v2') && asPoster.entries[0].hunter.name === 'deep-scout', asPoster);
const [, asOther] = await call('/v1/bounties/1', {}, os);
check('hunters see only their own result', asOther.entries[0].result === null && asOther.entries[1].result === 'other answer', asOther);
const [, anon] = await call('/v1/bounties/1');
check('public sees no results', anon.entries.every((e) => e.result === null) && anon.submissions === 2, anon);
check('cannot cancel with entries', (await post('/v1/bounties/1/cancel', {}, ps))[0] === 409);

// ---- payment ----
const subId = asPoster.entries[0].id;
txs[sig('a')] = transferTx(poster.address, hunter.address, 0.3);
const [u1, under] = await post('/v1/bounties/1/paid', { submission: subId, tx: sig('a') }, ps);
check('underpayment rejected', u1 === 400 && /sends 0.3 SOL/.test(under.error), under);
txs[sig('b')] = transferTx(poster.address, other.address, 0.5);
check('payment to someone else rejected', (await post('/v1/bounties/1/paid', { submission: subId, tx: sig('b') }, ps))[0] === 400);
txs[sig('c')] = transferTx(poster.address, hunter.address, 0.5);
check('only the poster can mark paid', (await post('/v1/bounties/1/paid', { submission: subId, tx: sig('c') }, hs))[0] === 403);
const [pp, paid] = await post('/v1/bounties/1/paid', { submission: subId, tx: sig('c') }, ps);
check('verified payout marks the bounty paid', pp === 200 && paid.status === 'paid' && paid.winner.wallet === hunter.address && paid.entries[0].winner === true, paid);
check('a transfer pays once', (await post('/v1/bounties/2/paid', { submission: subId, tx: sig('c') }, ps))[0] >= 400);
check('closed bounty takes no entries', (await post('/v1/bounties/1/submit', { result: 'late' }, os))[0] === 409);

// ---- cancel ----
check('stranger cannot cancel', (await post(`/v1/bounties/${b2.id}/cancel`, {}, os))[0] === 403);
const [cc, cx] = await post(`/v1/bounties/${b2.id}/cancel`, {}, ps);
check('poster cancels an empty bounty', cc === 200 && cx.status === 'cancelled', cx);

// ---- unpaid record ----
const [, b3] = await post('/v1/bounties', { ...job, title: 'Summarise 10 agent whitepapers', rewardSol: 0.2, hours: 1 }, ps);
await post(`/v1/bounties/${b3.id}/submit`, { result: 'summaries...' }, hk);
env.DB.prepare('UPDATE bounties SET deadline = ? WHERE id = ?').bind(Date.now() - 80 * 3600000, b3.id).run();
const [, b3v] = await call(`/v1/bounties/${b3.id}`);
check('missed payment shows as unpaid', b3v.status === 'unpaid' && b3v.posterRecord.unpaid === 1 && b3v.posterRecord.paid === 1, b3v);

// ---- leaderboard, stats, me ----
const [, lb] = await call('/v1/leaderboard');
check('leaderboard', lb.hunters[0].name === 'deep-scout' && lb.hunters[0].earnedSol === 0.5 && lb.posters[0].unpaid === 1, lb);
const [, st] = await call('/v1/stats');
check('stats', st.paidBounties === 1 && st.paidSol === 0.5 && st.hunters === 2 && st.postBurn === 0, st);
const [, mine] = await call('/v1/me', {}, hk);
check('me for a hunter', mine.name === 'deep-scout' && mine.submissions.some((s) => s.won) && mine.via === 'agent', mine);

// ---- MCP ----
const [, init] = await mcp('initialize', {});
check('mcp initialize', init.result.serverInfo.name === 'wanted', init);
const [, tl] = await mcp('tools/list', {});
check('mcp tools', tl.result.tools.map((t) => t.name).join() === 'list_bounties,get_bounty,submit_result,my_submissions', tl);
const [, b4] = await post('/v1/bounties', { ...job, title: 'Label 200 tweets as bullish or bearish', rewardSol: 0.05 }, ps);
const [, ml] = await mcp('tools/call', { name: 'list_bounties', arguments: {} });
check('mcp list_bounties', ml.result.content[0].text.includes(`#${b4.id} · 0.05 SOL`), ml);
const [, ms0] = await mcp('tools/call', { name: 'submit_result', arguments: { id: b4.id, result: 'labels.csv' } });
check('mcp submit needs a key', ms0.result.isError === true, ms0);
const [, ms] = await mcp('tools/call', { name: 'submit_result', arguments: { id: b4.id, result: 'https://example.com/labels.csv' } }, hk);
check('mcp submit_result', !ms.result.isError && /Entry sent/.test(ms.result.content[0].text), ms);
const [, mg] = await mcp('tools/call', { name: 'get_bounty', arguments: { id: b4.id } }, hk);
check('mcp get_bounty shows own entry', mg.result.content[0].text.includes('Your entry:\nhttps://example.com/labels.csv'), mg);
const [, mm] = await mcp('tools/call', { name: 'my_submissions', arguments: {} }, hk);
check('mcp my_submissions', mm.result.content[0].text.includes('WON'), mm);

// ---- after launch: burn to post, holders-only window ----
env.TOKEN_ADDRESS = MINT;
const [, nb] = await post('/v1/bounties', { ...job, rewardSol: 0.05 }, os);
check('posting needs a burn after launch', /burn 25,000/.test(nb.error), nb);
balances[other.address] = 1e9;
txs[sig('d')] = burnTx(other.address, 10000);
check('too small a burn', /at least 25,000/.test((await post('/v1/bounties', { ...job, rewardSol: 0.05, burnTx: sig('d') }, os))[1].error));
txs[sig('e')] = burnTx(other.address, 25000);
const [pe, fresh] = await post('/v1/bounties', { ...job, title: 'Fresh bounty for holders', rewardSol: 0.05, burnTx: sig('e') }, os);
check('post with burn', pe === 201, fresh);
check('a burn posts once', (await post('/v1/bounties', { ...job, rewardSol: 0.05, burnTx: sig('e') }, os))[0] === 409);
const [, pub] = await call('/v1/bounties');
check('fresh bounty hidden from the public', !pub.bounties.some((b) => b.id === fresh.id) && pub.hiddenForHolders >= 1, pub);
check('non-holder cannot open it', (await call(`/v1/bounties/${fresh.id}`, {}, hk))[0] === 403);
check('non-holder cannot enter it', (await post(`/v1/bounties/${fresh.id}/submit`, { result: 'early' }, hk))[0] === 403);
holdings[stranger.address] = 600000;
const ss = (await signIn(stranger))[1].session;
const [, holderView] = await call('/v1/bounties', {}, ss);
check('holder sees it live', holderView.early === true && holderView.bounties.some((b) => b.id === fresh.id), holderView);
check('holder can enter it', (await post(`/v1/bounties/${fresh.id}/submit`, { result: 'early bird' }, ss))[0] === 200);
check('poster always sees own bounty', (await call(`/v1/bounties/${fresh.id}`, {}, os))[0] === 200);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
