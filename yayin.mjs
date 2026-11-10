#!/usr/bin/env node
// NGE Instagram yayın betiği. Node 18 ve üzeri, ek paket gerekmez.
//
//   node yayin.mjs            zamanı gelen gönderileri paylaşır
//   node yayin.mjs --kontrol  token, kuyruk ve görsel adreslerini denetler, paylaşım yapmaz
//   node yayin.mjs --deneme   neyi paylaşacağını yazar, paylaşmaz
//
// Ortam değişkenleri: IG_TOKEN, IG_USER_ID, IMAGE_BASE_URL (görsellerin herkese açık kök adresi)

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ENV = process.env;
const API = (ENV.IG_API_BASE || 'https://graph.instagram.com').replace(/\/+$/, '') + (ENV.IG_API_VERSION ? '/' + ENV.IG_API_VERSION : '');
const TOKEN = ENV.IG_TOKEN || '';
const USER = ENV.IG_USER_ID || '';
const BASE = (ENV.IMAGE_BASE_URL || '').replace(/\/+$/, '');
const DIR = ENV.KUYRUK_DIR || 'kuyruk';
const MAX_LATE_H = Number(ENV.MAX_GEC_SAAT || 24);
const MAX_RUN = Number(ENV.RUN_BASINA_EN_FAZLA || 2);
const POLL_MS = Number(ENV.POLL_MS || 10000);
const POLL_N = Number(ENV.POLL_N || 30);
const args = new Set(process.argv.slice(2));
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, params = {}) {
  const url = new URL(`${API}/${path}`);
  const init = { method };
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    (method === 'GET' ? url.searchParams : body).set(k, String(v));
  }
  if (method === 'GET') url.searchParams.set('access_token', TOKEN);
  else {
    body.set('access_token', TOKEN);
    init.body = body;
    init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* yanıt JSON değil */ }
  if (!res.ok || !json || json.error) {
    const e = json && json.error;
    throw new Error(e
      ? `Instagram hatası ${e.code}${e.error_subcode ? '/' + e.error_subcode : ''}: ${e.message}`
      : `Beklenmeyen yanıt (${res.status}): ${text.slice(0, 200)}`);
  }
  return json;
}

async function waitFinished(id) {
  for (let i = 0; i < POLL_N; i++) {
    const s = await api('GET', id, { fields: 'status_code' });
    if (!s.status_code || s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`Konteyner ${id} durumu: ${s.status_code}`);
    await sleep(POLL_MS);
  }
  throw new Error(`Konteyner ${id} zamanında hazır olmadı`);
}

const urlOf = (p) => /^https?:\/\//i.test(p) ? p : `${BASE}/${String(p).split('/').map(encodeURIComponent).join('/')}`;

function validate(item) {
  const p = [];
  if (!item.zaman || Number.isNaN(Date.parse(item.zaman))) p.push('zaman geçersiz');
  if (!Array.isArray(item.gorseller) || item.gorseller.length < 1 || item.gorseller.length > 10) p.push('görsel sayısı 1 ile 10 arasında olmalı');
  else if (item.gorseller.some((g) => !/\.jpe?g(\?.*)?$/i.test(String(g)))) p.push('görseller JPEG (.jpg) olmalı');
  const cap = String(item.aciklama || '');
  if (!cap.trim()) p.push('açıklama boş');
  if (cap.length > 2200) p.push('açıklama 2.200 karakteri aşıyor');
  if ((cap.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) p.push('30’dan fazla etiket var');
  return p;
}

async function checkImage(url) {
  let r = await fetch(url, { method: 'HEAD' }).catch(() => null);
  if (!r || !r.ok) r = await fetch(url, { headers: { range: 'bytes=0-0' } }).catch(() => null);
  if (!r || !(r.ok || r.status === 206)) throw new Error(`Görsele erişilemiyor (${r ? r.status : 'bağlantı yok'}): ${url}`);
  const t = r.headers.get('content-type') || '';
  if (!/^image\/jpeg/i.test(t)) throw new Error(`Görsel JPEG olarak sunulmuyor (${t || 'tür yok'}): ${url}`);
}

async function publish(item, save) {
  const urls = item.gorseller.map(urlOf);
  for (const u of urls) await checkImage(u);
  let creation;
  if (urls.length === 1) {
    creation = (await api('POST', `${USER}/media`, { image_url: urls[0], caption: item.aciklama })).id;
  } else {
    const kids = [];
    for (const u of urls) kids.push((await api('POST', `${USER}/media`, { image_url: u, is_carousel_item: 'true' })).id);
    for (const k of kids) await waitFinished(k);
    creation = (await api('POST', `${USER}/media`, { media_type: 'CAROUSEL', children: kids.join(','), caption: item.aciklama })).id;
  }
  await waitFinished(creation);
  // Paylaşmadan hemen önce işaretle: bu noktadan sonra yarıda kalırsa aynı gönderi ikinci kez paylaşılmaz.
  item.durum = 'yayinlaniyor';
  item.konteyner = creation;
  await save();
  let out;
  for (let tries = 1; ; tries++) {
    try { out = await api('POST', `${USER}/media_publish`, { creation_id: creation }); break; }
    catch (e) {
      if (tries < 5 && /9007|not ready|hazır değil/i.test(e.message)) { await sleep(POLL_MS); continue; }
      throw e;
    }
  }
  item.durum = 'yayinlandi';
  item.mediaId = out.id;
  item.yayinZamani = new Date().toISOString();
  try { item.baglanti = (await api('GET', out.id, { fields: 'permalink' })).permalink; } catch { /* bağlantı alınamazsa sorun değil */ }
  await save();
}

async function loadQueue() {
  const files = (await readdir(DIR).catch(() => [])).filter((f) => f.endsWith('.json')).sort();
  const list = [];
  for (const f of files) {
    const path = join(DIR, f);
    try {
      const item = JSON.parse(await readFile(path, 'utf8'));
      item.durum = item.durum || 'bekliyor';
      list.push({ f, item, save: () => writeFile(path, JSON.stringify(item, null, 2) + '\n') });
    } catch (e) {
      log(`! ${f} okunamadı: ${e.message}`);
      process.exitCode = 1;
    }
  }
  return list;
}

async function kontrol(queue) {
  if (!TOKEN) { log('! IG_TOKEN tanımlı değil'); process.exitCode = 1; }
  else {
    try {
      const me = await api('GET', 'me', { fields: 'user_id,username' });
      log(`Token geçerli: @${me.username} (IG_USER_ID: ${me.user_id})`);
    } catch (e) { log('! Token sınanamadı:', e.message); process.exitCode = 1; }
  }
  if (!queue.length) log('Kuyruk boş.');
  for (const { f, item } of queue) {
    const problems = validate(item);
    if (item.durum === 'bekliyor' && BASE && !problems.length) {
      for (const g of item.gorseller) { try { await checkImage(urlOf(g)); } catch (e) { problems.push(e.message); } }
    }
    log(`${problems.length ? '!' : '-'} ${f}: ${item.durum}, ${item.zaman}${problems.length ? '\n    ' + problems.join('\n    ') : ''}`);
    if (problems.length && item.durum === 'bekliyor') process.exitCode = 1;
  }
}

async function main() {
  const queue = await loadQueue();
  if (args.has('--kontrol')) return kontrol(queue);
  if (!TOKEN || !USER || !BASE) throw new Error('IG_TOKEN, IG_USER_ID ve IMAGE_BASE_URL tanımlı olmalı.');

  for (const x of queue.filter((q) => q.item.durum === 'yayinlaniyor')) {
    log(`! ${x.f}: önceki çalışma yarıda kalmış. Instagram’da gönderi var mı bakın. Yoksa durum alanını "bekliyor" yapın.`);
    process.exitCode = 1;
  }

  const now = Date.now();
  const due = [];
  for (const x of queue.filter((q) => q.item.durum === 'bekliyor')) {
    const problems = validate(x.item);
    if (problems.length) { x.item.durum = 'hata'; x.item.hata = problems.join('; '); await x.save(); log(`! ${x.f}: ${x.item.hata}`); process.exitCode = 1; continue; }
    const t = Date.parse(x.item.zaman);
    if (t > now) continue;
    if (now - t > MAX_LATE_H * 3600e3) { x.item.durum = 'kacirildi'; await x.save(); log(`! ${x.f}: zamanı ${MAX_LATE_H} saatten fazla geçmiş, paylaşılmadı (kacirildi).`); process.exitCode = 1; continue; }
    due.push(x);
  }
  due.sort((a, b) => Date.parse(a.item.zaman) - Date.parse(b.item.zaman));
  log(`Kuyruk: ${queue.length} gönderi, zamanı gelen: ${due.length}`);

  let done = 0;
  for (const x of due.slice(0, MAX_RUN)) {
    if (args.has('--deneme')) { log(`(deneme) paylaşılacaktı: ${x.f}, ${x.item.gorseller.length} görsel`); continue; }
    try {
      log(`Paylaşılıyor: ${x.f}`);
      await publish(x.item, x.save);
      done++;
      log(`  yayınlandı: ${x.item.baglanti || x.item.mediaId}`);
    } catch (e) {
      if (x.item.durum !== 'yayinlandi') { x.item.durum = x.item.durum === 'yayinlaniyor' ? 'yayinlaniyor' : 'hata'; }
      x.item.hata = e.message;
      await x.save();
      log(`! ${x.f}: ${e.message}`);
      process.exitCode = 1;
      break;
    }
  }
  log(`Paylaşılan: ${done}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
