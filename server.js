'use strict';
// Crystal Deals backend: zero dependencies, Node 18+. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_PASSWORD || '';
const TONW = process.env.TON_WALLET || 'UQC9Z52pCtofOwqvCA3F9vr3D98b6mqV8gJlSQgIht87FoGm';
let FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.accessSync(path.dirname(FILE), fs.constants.W_OK); }
catch (e) { console.log('WARNING: cannot write to', FILE, '-', e.message, '-> using local data.json, data will be LOST on restart. Attach a disk and check DATA_FILE.'); FILE = path.join(__dirname, 'data.json'); }
console.log('Data file:', FILE);
const UP = path.join(path.dirname(FILE), 'uploads'); fs.mkdirSync(UP, { recursive: true });
// Images are stored as files and referenced by URL, so API responses stay small
function putImg(s, max) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) E('Нужно изображение (JPG, PNG или WebP)');
  const buf = Buffer.from(m[2], 'base64'); if (buf.length > max) E('Фото слишком большое');
  const id = crypto.randomBytes(12).toString('hex') + '.' + (m[1] == 'jpeg' ? 'jpg' : m[1]);
  fs.writeFileSync(path.join(UP, id), buf); return '/img/' + id;
}
const PUB = path.join(__dirname, 'public');
// Demo rates: units of currency per 1 RUB. Replace with a live source before real use.
// Rates: units of currency per 1 RUB. Starts with fallback values, then is refreshed from live sources (CoinGecko, fallback Binance + open.er-api).
const R = { RUB: 1, USDT: .011, EUR: .0095, UAH: .45, KZT: 5.3, BYN: .035, TON: .0037, BTC: 1.1e-7, ETH: 3.7e-6, LTC: 1.2e-4, SOL: 7.3e-5, STARS: .85 };
const STAR_USD = 0.013; // price of one Telegram Star in USD
let ratesAt = 0; // timestamp of the last successful live update (0 = never)
const rok = () => Date.now() - ratesAt < 30 * 6e4;
const fin = x => typeof x == 'number' && isFinite(x) && x > 0;
async function getJ(u, h) { const r = await fetch(u, { signal: AbortSignal.timeout(10000), headers: { accept: 'application/json', ...h } }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + new URL(u).hostname); return r.json(); }
// Fallback sources: fiat from open.er-api / currency-api, coin prices from several exchanges (Binance blocks some cloud regions, so we try mirrors)
async function fiatRates() {
  const okF = f => f && fin(f.RUB) && fin(f.EUR) && fin(f.UAH) && fin(f.KZT);
  try { const f = (await getJ('https://open.er-api.com/v6/latest/USD')).rates; if (okF(f)) return f; } catch (e) { console.log('er-api failed:', e.message); }
  try { const j = (await getJ('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json')).usd, f = {}; for (const k of ['RUB', 'EUR', 'UAH', 'KZT', 'BYN']) f[k] = j[k.toLowerCase()]; if (okF(f)) return f; } catch (e) { console.log('currency-api failed:', e.message); }
  throw new Error('no fiat rates');
}
async function coinUsd(k) {
  const sym = k + 'USDT', tries = [
    async () => +(await getJ('https://data-api.binance.vision/api/v3/ticker/price?symbol=' + sym)).price,
    async () => +(await getJ('https://api.binance.com/api/v3/ticker/price?symbol=' + sym)).price,
    async () => +(await getJ('https://www.okx.com/api/v5/market/ticker?instId=' + k + '-USDT')).data[0].last,
    async () => +(await getJ('https://api.bybit.com/v5/market/tickers?category=spot&symbol=' + sym)).result.list[0].lastPrice,
  ];
  for (const t of tries) { try { const v = await t(); if (fin(v)) return v; } catch (e) { /* try next source */ } }
  throw new Error('no price for ' + k);
}
function applyRates(rubPerUsd, fiatPerUsd, usdPrice) {
  // rubPerUsd: RUB for 1 USD; fiatPerUsd: {EUR,UAH,KZT} units per 1 USD; usdPrice: {TON,BTC,ETH,LTC,SOL} USD per coin
  const n = { RUB: 1, USDT: 1 / rubPerUsd, STARS: 1 / rubPerUsd / STAR_USD };
  for (const k of ['EUR', 'UAH', 'KZT']) n[k] = fiatPerUsd[k] / rubPerUsd;
  if (fin(fiatPerUsd.BYN)) n.BYN = fiatPerUsd.BYN / rubPerUsd;
  for (const k of ['TON', 'BTC', 'ETH', 'LTC', 'SOL']) n[k] = 1 / (usdPrice[k] * rubPerUsd);
  if (!Object.values(n).every(fin)) throw new Error('bad rates');
  Object.assign(R, n); ratesAt = Date.now();
}
async function updateRates() {
  try {
    const j = await getJ('https://api.coingecko.com/api/v3/simple/price?ids=tether,the-open-network,bitcoin,ethereum,litecoin,solana&vs_currencies=usd,rub,eur,uah,kzt', process.env.COINGECKO_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_KEY } : {});
    const t = j.tether, rub = t.rub / t.usd;
    applyRates(rub, { EUR: t.eur / t.usd, UAH: t.uah / t.usd, KZT: t.kzt / t.usd }, { TON: j['the-open-network'].usd, BTC: j.bitcoin.usd, ETH: j.ethereum.usd, LTC: j.litecoin.usd, SOL: j.solana.usd });
    try { const f = (await getJ('https://open.er-api.com/v6/latest/USD')).rates; if (fin(f.BYN)) R.BYN = f.BYN / rub; } catch (e) { /* BYN is optional */ }
    return console.log('Rates updated (CoinGecko)');
  } catch (e) { console.log('CoinGecko rates failed:', e.message); }
  try {
    const f = await fiatRates(), pr = {}, ks = ['TON', 'BTC', 'ETH', 'LTC', 'SOL'];
    (await Promise.all(ks.map(coinUsd))).forEach((v, i) => pr[ks[i]] = v);
    applyRates(f.RUB, f, pr); console.log('Rates updated (exchanges + fiat)');
  } catch (e) { console.log('Fallback rates failed:', e.message, '- keeping previous rates'); }
}
updateRates(); setInterval(updateRates, 6e4);

let db = { users: {}, deals: {}, tok: {}, pay: [], wd: [], paid: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
db.reviews = db.reviews || []; db.credits = db.credits || [];
for (const u of Object.values(db.users)) for (const k of Object.keys(R)) if (!(k in u.w)) u.w[k] = 0;
// Debounced atomic save (coalesces bursts, flushed on exit)
let dirty = false, tm = null;
const flush = () => { tm = null; if (!dirty) return; dirty = false; try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); } catch (e) { dirty = true; console.error('SAVE FAILED', e.message); } };
const save = () => { dirty = true; if (!tm) tm = setTimeout(flush, 200); };
for (const sg of ['SIGTERM', 'SIGINT']) process.on(sg, () => { flush(); process.exit(0); });
process.on('exit', flush);

const E = m => { throw { err: m }; };
// ---- requisites validation ----
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58d(s) { let n = 0n; for (const c of s) { const i = B58.indexOf(c); if (i < 0) return null; n = n * 58n + BigInt(i); } let h = n.toString(16); if (h.length % 2) h = '0' + h; let b = n === 0n ? Buffer.alloc(0) : Buffer.from(h, 'hex'), z = 0; for (const c of s) { if (c == '1') z++; else break; } return Buffer.concat([Buffer.alloc(z), b]); }
const sha = b => crypto.createHash('sha256').update(b).digest();
function b58chk(s) { const b = b58d(s); if (!b || b.length < 5) return null; const p = b.subarray(0, -4); return sha(sha(p)).subarray(0, 4).equals(b.subarray(-4)) ? p : null; }
function crc16(buf) { let c = 0; for (const x of buf) { c ^= x << 8; for (let i = 0; i < 8; i++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1); c &= 0xffff; } return c; }
function tonOk(a) {
  if (/^-?\d{1,3}:[0-9a-fA-F]{64}$/.test(a)) return true;
  if (!/^[A-Za-z0-9_-]{48}$/.test(a)) return false;
  const b = Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return b.length == 36 && (b[0] == 0x11 || b[0] == 0x51) && (b[1] == 0 || b[1] == 0xff) && crc16(b.subarray(0, 34)) == b.readUInt16BE(34);
}
function bech32Ok(a) {
  if (a != a.toLowerCase() && a != a.toUpperCase()) return false; a = a.toLowerCase();
  if (!/^bc1[02-9ac-hj-np-z]{39,87}$/.test(a)) return false;
  const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const d = [...a.slice(3)].map(c => CS.indexOf(c)); let c = 1;
  for (const x of [3, 3, 0, 2, 3, ...d]) { const t = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ x; for (let i = 0; i < 5; i++) if ((t >> i) & 1) c ^= G[i]; c >>>= 0; }
  return d[0] == 0 ? (c == 1 && (a.length == 42 || a.length == 62)) : (c == 0x2bc830a3 && d[0] <= 16);
}
const NETS = {
  TON: a => tonOk(a),
  TRC20: a => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) && (p => !!p && p.length == 21 && p[0] == 0x41)(b58chk(a)),
  ERC20: a => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a),
  BEP20: a => /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a),
  BTC: a => /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a) ? (p => !!p && p.length == 21 && (p[0] == 0 || p[0] == 5))(b58chk(a)) : bech32Ok(a),
  SOL: a => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && (b => !!b && b.length == 32)(b58d(a)),
};
const NETHINT = { TON: 'TON: адрес начинается с UQ или EQ (48 символов)', TRC20: 'TRC20: адрес начинается с T (34 символа)', ERC20: 'ERC20: адрес начинается с 0x (42 символа)', BEP20: 'BEP20: адрес начинается с 0x (42 символа)', BTC: 'BTC: адрес начинается с 1, 3 или bc1', SOL: 'SOL: адрес из 32–44 символов Base58' };
function luhn(n) { let s = 0, d = false; for (let i = n.length - 1; i >= 0; i--) { let x = +n[i]; if (d) { x *= 2; if (x > 9) x -= 9; } s += x; d = !d; } return s % 10 == 0; }

const r8 = x => Math.round(x * 1e8) / 1e8;
const bal = u => Object.entries(u.w).reduce((s, [k, v]) => s + v / R[k], 0);
function spend(u, x) { for (const k of [u.cur, ...Object.keys(R)]) { if (x <= 1e-9) break; const t = Math.min(u.w[k] / R[k], x); u.w[k] = r8(u.w[k] - t * R[k]); x -= t; } }
const rid = n => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: n }, () => A[crypto.randomInt(A.length)]).join(''); };
const hash = (p, s) => crypto.scryptSync(p, s, 32).toString('hex');
const eq = (a, b) => a.length == b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const tries = {};
const tries2 = {}; const limited2 = ip => { const n = Date.now(), a = (tries2[ip] = (tries2[ip] || []).filter(t => n - t < 6e4)); a.push(n); return a.length > 120; };
const limited = ip => { const n = Date.now(), a = (tries[ip] = (tries[ip] || []).filter(t => n - t < 6e4)); a.push(n); return a.length > 20; };
const sys = (d, to, x) => d.m.push({ k: 's', to, t: Date.now(), x });
const rdet = r => r.t == 'stars' ? r.a : r.t == 'card' ? (r.sbp ? `СБП +${r.a} · ${r.b}` : `${r.cc} ${r.a}`) : `${r.a} · ${r.b} · ${r.c}`;
const okImg = (i, max) => typeof i == 'string' && i.startsWith('data:image/') && i.length <= max;

function release(d) {
  const s = db.users[d.seller];
  if (d.ca && R[d.cur]) s.w[d.cur] = r8(s.w[d.cur] + d.ca); // seller is paid in the currency of the deal
  else s.w[s.cur] = r8(s.w[s.cur] + d.amt * R[s.cur]);
  d.st = 'done'; sys(d, 'all', 'done'); sys(d, 'buyer', 'done_b'); sys(d, 'seller', 'done_s');
}
function rename(o, n) {
  const u = db.users[o]; delete db.users[o]; u.nick = n; db.users[n] = u;
  for (const d of Object.values(db.deals)) { if (d.seller == o) d.seller = n; if (d.buyer == o) d.buyer = n; for (const m of d.m) if (m.f == o) m.f = n; }
  for (const r of db.reviews) { if (r.u == o) r.u = n; if (r.to == o) r.to = n; }
  for (const p of db.pay) if (p.u == o) p.u = n;
  for (const w of db.wd) if (w.u == o) w.u = n;
  for (const t of Object.values(db.tok)) if (t.nick == o) t.nick = n;
}
const NETCUR = { TON: ['TON', 'USDT'], TRC20: ['USDT'], ERC20: ['USDT', 'ETH'], BEP20: ['USDT'], BTC: ['BTC'], SOL: ['SOL'] };
const curFor = r => r.t == 'stars' ? ['STARS'] : r.t == 'crypto' ? (NETCUR[r.b] || ['USDT']) : ({ RU: ['RUB'], UA: ['UAH'], KZ: ['KZT'], BY: ['BYN'] })[r.cc] || ['RUB'];
const TYPES = ['NFT', 'NFT юзернейм', 'NFT номер', 'Аккаунт', 'Разное'];
function itemOf(type, raw) {
  const s = String(raw || '').trim();
  if (type == 'NFT') {
    if (s.length > 300 || !/^(https?:\/\/)?[^\s\/]+\.[^\s]+$/i.test(s)) E('Вставьте ссылку на NFT');
    return /^https?:\/\//i.test(s) ? s : 'https://' + s;
  }
  if (type == 'NFT юзернейм') {
    const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(s.replace(/^(https?:\/\/)?t\.me\//i, '')); if (!m) E('Введите юзернейм, например @username');
    return '@' + m[1];
  }
  if (type == 'NFT номер') {
    const d = s.replace(/[\s\-()+]/g, ''); if (!/^\d{4,15}$/.test(d)) E('Введите номер цифрами, например 888 0000 0000');
    return '+' + d;
  }
  if (s.length < 2) E('Опишите товар'); return s.slice(0, 1000);
}
const mine = (u, id) => { const d = db.deals[id]; if (!d || (d.seller != u.nick && d.buyer != u.nick)) E('Сделка не найдена'); return d; };
const RANKS = [['bronze', 0], ['silver', 5], ['gold', 15], ['platinum', 40], ['diamond', 100]];
const rankOf = n => { let r = RANKS[0][0]; for (const [k, v] of RANKS) if (n >= v) r = k; return r; };
function doneMap() { const m = {}; for (const d of Object.values(db.deals)) if (d.st == 'done') { m[d.seller] = (m[d.seller] || 0) + 1; if (d.buyer) m[d.buyer] = (m[d.buyer] || 0) + 1; } for (const u of Object.values(db.users)) if (u.bonus) m[u.nick] = (m[u.nick] || 0) + u.bonus; return m; }
const card = (n, DC) => { const u = db.users[n]; if (!u) return { nick: n }; const dn = DC[n] || 0; return { nick: u.nick, avatar: u.avatar, since: u.since, bio: u.bio || '', dn, rank: rankOf(dn) }; };
const pub = (u, DC) => ({ ...card(u.nick, DC), cur: u.cur, w: u.w, reqs: u.reqs, nickAt: u.nickAt || 0, bonus: u.bonus || 0 });
const rto = r => r.to || (() => { const d = db.deals[r.deal]; return d ? (r.u == d.seller ? d.buyer : d.seller) : null; })();
const dv = (d, u) => { const sel = u.nick == d.seller, x = { ...d, m: d.m.filter(m => m.k == 'm' || m.to == 'all' || m.to == (sel ? 'seller' : 'buyer')) }; if (!sel) delete x.rq; if (d.st == 'wait' && d.ca && R[d.cur]) x.amt = r8(d.ca / R[d.cur]); const mr = db.reviews.find(r => r.deal == d.id && r.u == u.nick && (r.st || 'ok') != 'no'); x.reviewed = !!mr; x.rvst = mr ? (mr.st || 'ok') : ''; return x; };
const shown = r => !r.hide && (r.st || 'ok') == 'ok'; // reviews without status (old ones) count as approved
const mask = n => n.length <= 3 ? n[0] + '**' : n.slice(0, 2) + '***' + n.slice(-1);
function pubData() { const rv = db.reviews.filter(shown); return { rates: R, ratesAt, deals: Object.values(db.deals).filter(d => d.st == 'done').length, users: Object.keys(db.users).length, n: rv.length, avg: rv.length ? Math.round(rv.reduce((a, r) => a + r.stars, 0) / rv.length * 10) / 10 : 0, reviews: rv.slice(-30).reverse().map(r => ({ n: r.by == 'admin' ? r.u : mask(r.u), stars: r.stars, x: r.x, t: r.t, reply: r.reply })) }; }
function view(u) {
  const DC = doneMap(), users = { [u.nick]: pub(u, DC) }, deals = {};
  for (const d of Object.values(db.deals)) if (d.seller == u.nick || d.buyer == u.nick) {
    deals[d.id] = dv(d, u);
    for (const n of [d.seller, d.buyer]) if (n && !users[n]) users[n] = card(n, DC);
  }
  return { rates: R, ratesAt, me: u.nick, users, deals, pay: db.pay.filter(p => p.u == u.nick), wd: db.wd.filter(x => x.u == u.nick) };
}

const H = {
  logout(u, b, tk) { delete db.tok[tk]; return {}; },
  state: () => ({}),
  avatar(u, b) { u.avatar = putImg(b.img, 700000); return {}; },
  'profile.edit'(u, b) {
    if (b.bio !== undefined) u.bio = String(b.bio).replace(/\s+/g, ' ').trim().slice(0, 200);
    const n = String(b.nick || '').trim();
    if (n && n != u.nick) {
      if (!/^[A-Za-z0-9_]{3,20}$/.test(n)) E('Ник: 3–20 символов, латиница, цифры и _');
      if (u.nickAt && Date.now() - u.nickAt < 14 * 864e5) E('Ник можно менять раз в 14 дней');
      if (Object.values(db.deals).some(d => (d.seller == u.nick || d.buyer == u.nick) && ['paid', 'handed'].includes(d.st))) E('Нельзя менять ник, пока есть оплаченные незавершённые сделки');
      if (Object.keys(db.users).some(k => k.toLowerCase() == n.toLowerCase() && k != u.nick)) E('Этот ник занят');
      rename(u.nick, n); u.nickAt = Date.now();
    }
    return {};
  },
  'user.get'(u, b) {
    const k = Object.keys(db.users).find(x => x.toLowerCase() == String(b.nick || '').toLowerCase()); if (!k) E('nf');
    const DC = doneMap(), c = card(k, DC), rv = db.reviews.filter(r => shown(r) && rto(r) == k);
    return { prof: { ...c, n: rv.length, avg: rv.length ? Math.round(rv.reduce((a, r) => a + r.stars, 0) / rv.length * 10) / 10 : 0, reviews: rv.slice(-100).reverse().map(r => ({ n: r.by == 'admin' ? r.u : mask(r.u), stars: r.stars, x: r.x, t: r.t, reply: r.reply })) } };
  },
  setcur(u, b) { if (!R[b.cur]) E('Неверная валюта'); u.cur = b.cur; return {}; },
  passwd(u, b) {
    if (!eq(hash(String(b.old), u.salt), u.pass)) E('Текущий пароль неверный');
    if (String(b.nw).length < 6) E('Новый пароль от 6 символов');
    u.salt = rid(16); u.pass = hash(String(b.nw), u.salt); return {};
  },
  'req.add'(u, b) {
    const r = b.r || {}, t = r.t;
    if (!['stars', 'crypto', 'card'].includes(t)) E('Неверный тип реквизитов');
    if (u.reqs.length >= 10) E('Слишком много реквизитов');
    const x = { id: rid(6), t, a: String(r.a || '').trim().slice(0, 64), main: !u.reqs.length };
    if (t == 'stars') {
      x.a = '@' + x.a.replace(/^@/, '');
      if (!/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(x.a)) E('Неверный юзернейм: 5–32 символа, латиница, цифры и _, начинается с буквы');
    } else if (t == 'crypto') {
      x.b = String(r.b || '').trim(); x.c = String(r.c || '').trim();
      if (!x.a || x.a.length < 2) E('Укажите название кошелька');
      if (!NETS[x.b]) E('Выберите сеть из списка');
      if (!NETS[x.b](x.c)) E('Адрес не похож на настоящий кошелёк сети ' + x.b + '. ' + NETHINT[x.b]);
      if (u.reqs.some(q => q.t == 'crypto' && q.c == x.c && q.b == x.b)) E('Этот кошелёк уже привязан');
    } else {
      if (!['UA', 'RU', 'BY', 'KZ'].includes(r.cc)) E('Неверная страна'); x.cc = r.cc;
      if (r.sbp) {
        if (r.cc != 'RU') E('СБП доступен только для России');
        let ph = String(r.a || '').replace(/\D/g, ''); if (ph.length == 11 && ph[0] == '8') ph = '7' + ph.slice(1);
        if (!/^79\d{9}$/.test(ph)) E('Телефон должен быть российским мобильным: +7 9XX XXX-XX-XX');
        x.sbp = 1; x.a = ph; x.b = String(r.b || '').trim().slice(0, 40); if (x.b.length < 2) E('Укажите банк');
      } else {
        x.a = String(r.a || '').replace(/\s/g, '');
        if (!/^\d{16}$/.test(x.a) || !/^[24569]/.test(x.a) || /^(\d)\1+$/.test(x.a)) E('Номер карты: 16 цифр');
        if (!luhn(x.a)) E('Такого номера карты не существует, проверьте цифры');
        if (u.reqs.some(q => q.t == 'card' && q.a == x.a)) E('Эта карта уже привязана');
      }
    }
    u.reqs.push(x); return {};
  },
  'req.main'(u, b) { u.reqs.forEach(r => r.main = r.id == b.id); return {}; },
  'req.del'(u, b) { u.reqs = u.reqs.filter(r => r.id != b.id); if (u.reqs.length && !u.reqs.some(r => r.main)) u.reqs[0].main = true; return {}; },
  'deal.create'(u, b) {
    const r = u.reqs.find(x => x.id == b.rid); if (!r) E('Выберите реквизиты для получения оплаты');
    const ok = curFor(r), cur = String(b.cur || ok[0]), ca = +b.ca;
    if (!ok.includes(cur)) E('Для этих реквизитов валюта сделки: ' + ok.join(' или '));
    if (!(ca > 0) || ca / R[cur] > 1e9) E('Неверная сумма');
    if (cur == 'STARS' && !Number.isInteger(ca)) E('Stars считаются целым числом');
    const type = TYPES.includes(b.type) ? b.type : 'Разное', lk = itemOf(type, b.lk);
    const d = { id: rid(8), seller: u.nick, type, amt: r8(ca / R[cur]), ca: r8(ca), cur, rq: String(b.rq || '').slice(0, 200), lk, st: 'wait', buyer: null, t: Date.now(), m: [] };
    sys(d, 'seller', 'created'); db.deals[d.id] = d; return { id: d.id };
  },
  'deal.open'(u, b) {
    const id = String(b.id || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase(), d = db.deals[id];
    if (!d) E('nf');
    if (!d.buyer && u.nick != d.seller && d.st == 'wait') { d.buyer = u.nick; sys(d, 'seller', 'join_s'); sys(d, 'buyer', 'join_b'); }
    if (u.nick != d.seller && u.nick != d.buyer) E('taken');
    return { id: d.id };
  },
  'deal.send'(u, b) {
    const d = mine(u, b.id), x = String(b.x || '').slice(0, 2000), i = b.i;
    if (!x && !i) E('Пустое сообщение');
    if (d.m.length > 2000) E('Лимит сообщений в сделке');
    d.m.push({ k: 'm', f: u.nick, t: Date.now(), x, i: i ? putImg(i, 500000) : undefined }); return {};
  },
  'deal.pay'(u, b) {
    const d = mine(u, b.id);
    if (u.nick == d.seller) E('Нельзя оплатить свою сделку');
    if (d.st != 'wait') E('Сделка уже оплачена или закрыта');
    if (d.ca && !rok()) E('Курс валют временно недоступен, попробуйте через минуту');
    if (d.ca) d.amt = r8(d.ca / R[d.cur]); // price is locked at the moment of payment
    if (bal(u) < d.amt - 1e-9) E('Недостаточно средств');
    spend(u, d.amt); d.st = 'paid'; sys(d, 'buyer', 'paid_b'); sys(d, 'seller', 'paid_s'); return {};
  },
  'deal.shot'(u, b) {
    const d = mine(u, b.id);
    if (u.nick != d.seller || d.st != 'paid') E('Сейчас это недоступно');
    d.m.push({ k: 'm', f: u.nick, t: Date.now(), x: 'Скриншот передачи товара', i: putImg(b.i, 500000) });
    d.st = 'handed'; sys(d, 'seller', 'shot_s'); sys(d, 'buyer', 'shot_b'); return {};
  },
  'deal.fin'(u, b) { const d = mine(u, b.id); if (u.nick != d.buyer || d.st != 'handed') E('Сейчас это недоступно'); release(d); return {}; },
  'deal.cancel'(u, b) { const d = mine(u, b.id); if (u.nick != d.seller || d.st != 'wait') E('Отменить нельзя'); d.st = 'cancel'; sys(d, 'all', 'cancel'); return {}; },
  'review.add'(u, b) {
    const d = mine(u, b.id);
    if (d.st != 'done') E('Отзыв можно оставить после завершения сделки');
    if (db.reviews.some(r => r.deal == d.id && r.u == u.nick && (r.st || 'ok') != 'no')) E('Вы уже оставили отзыв');
    const st = Math.round(+b.stars), x = String(b.x || '').trim().slice(0, 500);
    if (!(st >= 1 && st <= 5)) E('Поставьте оценку'); if (x.length < 3) E('Напишите пару слов');
    db.reviews.push({ id: rid(6), deal: d.id, u: u.nick, to: u.nick == d.seller ? d.buyer : d.seller, stars: st, x, t: Date.now(), hide: false, reply: '', st: 'pending' }); return {}; // st: pending -> waits for admin approval
  },
  wd(u, b) {
    const r = u.reqs.find(x => x.id == b.rid), a = +b.amt;
    if (!r) E('Выберите реквизиты'); if (!(a > 0)) E('Неверная сумма'); if (a > bal(u) + 1e-9) E('Недостаточно средств');
    spend(u, a); db.wd.push({ id: rid(6), u: u.nick, amt: r8(a), rq: rdet(r), st: 'pending', t: Date.now() }); return {};
  },
  fx(u, b) {
    const a = +b.amt, f = b.from, t = b.to;
    if (!R[f] || !R[t] || f == t || !(a > 0)) E('Проверьте валюты и сумму');
    if (!rok()) E('Курс валют временно недоступен, попробуйте через минуту');
    if (a > u.w[f] + 1e-9) E('Недостаточно средств');
    u.w[f] = r8(Math.max(0, u.w[f] - a)); u.w[t] = r8(u.w[t] + a * R[t] / R[f]); return {};
  },
  'pay.create'(u, b) {
    const a = +b.amt;
    if (!(a >= 0.5) || a > 100000) E('Минимум 0.5 TON');
    if (db.pay.some(p => p.u == u.nick && p.st == 'wait' && Date.now() - p.t < 18e5)) E('У вас уже есть активная оплата');
    let c; do c = 'CD-' + rid(8); while (db.pay.some(p => p.c == c));
    db.pay.push({ id: c, u: u.nick, amt: r8(a), c, t: Date.now(), st: 'wait' }); return {};
  },
  'pay.cancel'(u) { db.pay.filter(p => p.u == u.nick && p.st == 'wait').forEach(p => p.st = 'cancel'); return {}; },
  async 'pay.check'(u) { await checkPayments(); const p = [...db.pay].reverse().find(x => x.u == u.nick); return { status: p ? p.st : 'none' }; },
};

// TON deposits: match incoming transfers to the wallet by exact comment and amount, credit once per tx hash.
let busy = false;
async function checkPayments() {
  if (busy) return;
  const now = Date.now(); let changed = false;
  db.pay.forEach(p => { if (p.st == 'wait' && now - p.t > 18e5) { p.st = 'exp'; changed = true; } });
  const w = db.pay.filter(p => p.st == 'wait' || (p.st == 'exp' && now - p.t < 864e5)); // expired ones are still credited for 24h
  if (w.length) {
    busy = true;
    try {
      const j = await (await fetch('https://toncenter.com/api/v2/getTransactions?address=' + TONW + '&limit=100', { headers: process.env.TONCENTER_KEY ? { 'X-API-Key': process.env.TONCENTER_KEY } : {} })).json();
      if (j.ok) for (const p of w) {
        const tx = j.result.find(x => x.in_msg && x.in_msg.source && String(x.in_msg.message || '').trim() === p.c && +x.in_msg.value >= Math.round(p.amt * 1e9) * .995 && x.utime * 1000 >= p.t - 120000 && !db.paid.includes(x.transaction_id.hash));
        if (tx) { const u = db.users[p.u], v = +tx.in_msg.value / 1e9; db.paid.push(tx.transaction_id.hash); u.w.TON = r8(u.w.TON + v); p.st = 'done'; p.got = v; p.hash = tx.transaction_id.hash; changed = true; }
      }
    } catch (e) { console.log('TON check failed:', e.message); }
    busy = false;
  }
  if (changed) save();
}
setInterval(() => checkPayments().catch(() => {}), 30000);

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  if (req.method == 'POST' && url.pathname.startsWith('/api/')) {
    let body = '';
    for await (const ch of req) { body += ch; if (body.length > 1.5e6) return send(413, { err: 'Слишком большой запрос' }); }
    let b; try { b = JSON.parse(body || '{}'); } catch { return send(400, { err: 'Bad JSON' }); }
    const a = url.pathname.slice(5), ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    try {
      if (a == 'pub') return send(200, pubData());
      if (a == 'nick.check') { if (limited2(ip)) E('Слишком много запросов'); const n = String(b.nick || '').trim(), valid = /^[A-Za-z0-9_]{3,20}$/.test(n); return send(200, { valid, free: valid && !Object.keys(db.users).some(k => k.toLowerCase() == n.toLowerCase()) }); }
      if (a.startsWith('admin/')) {
        if (!ADMIN || !eq(String(req.headers['x-admin'] || ''), ADMIN)) return send(401, { err: 'Нет доступа' });
        const m = a.slice(6), find = (arr, id) => arr.find(x => x.id == id), uk = n => Object.keys(db.users).find(x => x.toLowerCase() == String(n || '').trim().replace(/^@/, '').toLowerCase()); let out = {};
        if (m == 'list') return send(200, { wd: db.wd.slice(-100).reverse(), pay: db.pay.slice(-100).reverse(), deals: Object.values(db.deals).slice(-100).reverse().map(d => ({ ...d, m: undefined, msgs: d.m.filter(x => x.k == 'm').length })), reviews: (rr => rr.filter(r => r.st == 'pending').concat(rr.filter(r => r.st != 'pending').slice(0, 100)))(db.reviews.slice().reverse()).map(r => ({ ...r, to: rto(r) })), users: Object.values(db.users).map(u => ({ nick: u.nick, w: u.w, since: u.since, cur: u.cur, bonus: u.bonus || 0 })), credits: db.credits.slice(-30).reverse(), cur: Object.keys(R) });
        if (m == 'wd.done') { const x = find(db.wd, b.id); if (x && x.st == 'pending') x.st = 'done'; }
        else if (m == 'wd.reject') { const x = find(db.wd, b.id); if (x && x.st == 'pending') { x.st = 'rejected'; const u = db.users[x.u]; u.w.RUB = r8(u.w.RUB + x.amt); } }
        else if (m == 'credit') {
          const k = uk(b.nick); if (!k) E('Пользователь «' + String(b.nick || '').trim() + '» не найден. Проверьте ник.');
          const u = db.users[k]; let c = String(b.cur || '').trim().toUpperCase(); c = ({ '₽': 'RUB', 'РУБ': 'RUB', 'RUR': 'RUB', 'USD': 'USDT', '$': 'USDT', '⭐': 'STARS', 'STAR': 'STARS' })[c] || c || u.cur;
          if (!R[c]) E('Неизвестная валюта «' + c + '». Доступны: ' + Object.keys(R).join(', '));
          const a = +String(b.amt == null ? '' : b.amt).replace(/\s/g, '').replace(',', '.'); if (!isFinite(a) || a == 0) E('Введите сумму числом, например 100 или 2.5');
          if ((u.w[c] || 0) + a < -1e-9) E('Нельзя списать больше, чем есть на балансе');
          u.w[c] = r8((u.w[c] || 0) + a); db.credits.push({ id: rid(6), u: k, cur: c, amt: a, t: Date.now() });
          out.msg = (a > 0 ? 'Зачислено ' : 'Списано ') + Math.abs(a) + ' ' + c + ' пользователю ' + k + '. Баланс теперь: ' + u.w[c] + ' ' + c;
        }
        else if (m == 'deal.add') {
          const sk = uk(b.seller); if (!sk) E('Продавец не найден'); let bk = null;
          if (String(b.buyer || '').trim()) { bk = uk(b.buyer); if (!bk) E('Покупатель не найден'); if (bk == sk) E('Продавец и покупатель — один человек'); }
          const type = TYPES.includes(b.type) ? b.type : 'Разное', cur = String(b.cur || '').trim().toUpperCase(), ca = +String(b.amt == null ? '' : b.amt).replace(',', '.');
          if (!R[cur]) E('Неизвестная валюта'); if (!(ca > 0)) E('Неверная сумма');
          const d = { id: rid(8), seller: sk, type, amt: r8(ca / R[cur]), ca: r8(ca), cur, rq: '', lk: itemOf(type, b.lk), st: 'wait', buyer: bk, t: Date.now(), m: [], by: 'admin' };
          sys(d, 'seller', 'created'); if (bk) { sys(d, 'seller', 'join_s'); sys(d, 'buyer', 'join_b'); }
          db.deals[d.id] = d; out.msg = 'Сделка #' + d.id + ' создана для ' + sk + (bk ? ' и ' + bk : '') + '. Она появилась у них в «Сделках».';
        }
        else if (m == 'deal.release') { const d = db.deals[b.id]; if (d && (d.st == 'paid' || d.st == 'handed')) release(d); }
        else if (m == 'deal.refund') { const d = db.deals[b.id]; if (d && (d.st == 'paid' || d.st == 'handed')) { const u = db.users[d.buyer]; u.w.RUB = r8(u.w.RUB + d.amt); d.st = 'cancel'; sys(d, 'all', 'refund'); } }
        else if (m == 'deals.bonus') {
          const k = uk(b.nick); if (!k) E('Пользователь «' + String(b.nick || '').trim() + '» не найден. Проверьте ник.');
          const n = Math.round(+String(b.n == null ? '' : b.n).replace(',', '.')); if (!isFinite(n) || n == 0 || Math.abs(n) > 10000) E('Введите количество сделок числом, например 5 (минус = убрать)');
          const u = db.users[k]; u.bonus = Math.max(0, (u.bonus || 0) + n);
          out.msg = (n > 0 ? 'Добавлено ' + n : 'Убрано ' + (-n)) + ' завершённых сделок у ' + k + '. Добавленных сделок теперь: ' + u.bonus + '. Ранг и счётчики в профиле обновятся.';
        }
        else if (m == 'review.add') {
          const k = uk(b.to); if (!k) E('Пользователь «' + String(b.to || '').trim() + '» не найден. Проверьте ник.');
          const from = String(b.from || '').trim().replace(/\s+/g, ' ').slice(0, 30); if (from.length < 2) E('Введите ник автора отзыва (от кого)');
          const st = Math.round(+b.stars || 5), x = String(b.x || '').trim().slice(0, 500);
          if (!(st >= 1 && st <= 5)) E('Оценка от 1 до 5'); if (x.length < 3) E('Напишите текст отзыва');
          db.reviews.push({ id: rid(6), deal: '', u: from, to: k, stars: st, x, t: Date.now(), hide: false, reply: '', st: 'ok', by: 'admin' });
          out.msg = 'Отзыв добавлен пользователю ' + k + ' от «' + from + '» и уже виден в его профиле.';
        }
        else if (m == 'review.ok') { const r = find(db.reviews, b.id); if (r) { r.st = 'ok'; r.hide = false; } }
        else if (m == 'review.no') { const r = find(db.reviews, b.id); if (r) r.st = 'no'; }
        else if (m == 'review.hide') { const r = find(db.reviews, b.id); if (r) r.hide = !r.hide; }
        else if (m == 'review.reply') { const r = find(db.reviews, b.id); if (r) r.reply = String(b.x || '').slice(0, 300); }
        else E('Unknown');
        save(); return send(200, { ok: 1, ...out });
      }
      if (a == 'register' || a == 'login') {
        if (limited(ip)) E('Слишком много попыток, подождите минуту');
        const n = String(b.nick || '').trim(), p = String(b.pass || '');
        if (a == 'register') {
          if (!/^[A-Za-z0-9_]{3,20}$/.test(n)) E('Ник: 3–20 символов, латиница, цифры и _');
          if (p.length < 6) E('Пароль от 6 символов');
          if (Object.keys(db.users).some(k => k.toLowerCase() == n.toLowerCase())) E('Этот ник занят');
          const salt = rid(16);
          db.users[n] = { nick: n, salt, pass: hash(p, salt), cur: 'RUB', avatar: '', since: Date.now(), w: Object.fromEntries(Object.keys(R).map(k => [k, 0])), reqs: [] };
          db.users[n].w.RUB = +process.env.TEST_BALANCE || 0;
        }
        const k = Object.keys(db.users).find(x => x.toLowerCase() == n.toLowerCase()), u = k && db.users[k];
        if (!u || !eq(hash(p, u.salt), u.pass)) E('Неверный ник или пароль');
        const token = crypto.randomBytes(24).toString('hex'); db.tok[token] = { nick: u.nick, t: Date.now() };
        save(); return send(200, { token, state: view(u) });
      }
      const tk = (req.headers.authorization || '').slice(7), s = db.tok[tk];
      if (s && Date.now() - s.t > 2.6e9) delete db.tok[tk];
      const u = db.tok[tk] && db.users[s.nick];
      if (!u) return send(200, { err: 'auth' });
      const f = H[a]; if (!f) return send(404, { err: 'Unknown' });
      const out = await f(u, b, tk); if (a != 'state' && a != 'user.get') save();
      return send(200, { ...out, state: db.tok[tk] ? view(u) : undefined });
    } catch (e) { if (e && e.err) return send(200, { err: e.err }); console.error(e); return send(500, { err: 'Ошибка сервера' }); }
  }
  if (url.pathname == '/health') { res.writeHead(200); return res.end('ok'); }
  const im = /^\/img\/([a-f0-9]{24}\.(jpg|png|webp))$/.exec(url.pathname);
  if (im) return fs.readFile(path.join(UP, im[1]), (e, d) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'image/' + (im[2] == 'jpg' ? 'jpeg' : im[2]), 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' }); res.end(d); });
  let p = url.pathname == '/' ? '/index.html' : url.pathname;
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' }); res.end(d); });
}).listen(PORT, () => console.log('Crystal Deals on http://localhost:' + PORT + (ADMIN ? '' : '  (admin disabled: set ADMIN_PASSWORD)')));
