#!/usr/bin/env node
// Post-deploy smoke test: node deploy/smoke.mjs offline | live | all
// Exit 1 on any failed step. The smoke workflow tags the commit last-known-good only when both parts pass.
import { appendFileSync } from 'node:fs';
import { smokeOffline, smokeLive } from './lib/smoke.mjs';

const part = process.argv[2] ?? 'offline';
const results = [];
if (part === 'offline' || part === 'all') results.push(['offline', await smokeOffline()]);
if (part === 'live' || part === 'all') results.push(['live', await smokeLive()]);
if (!results.length) {
  console.error('usage: node deploy/smoke.mjs offline | live | all');
  process.exit(1);
}
let ok = true;
for (const [name, r] of results) {
  for (const s of r.steps) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), lvl: s.ok ? 'info' : 'error', ev: 'smoke.step', part: name, step: s.name, ok: s.ok, detail: s.detail ?? undefined, error: s.error ?? undefined }));
    if (!s.ok && process.env.GITHUB_ACTIONS) console.log(`::error::smoke ${name}: ${s.name}: ${s.error}`);
  }
  ok &&= r.ok;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### smoke ${name}: ${r.ok ? 'PASS' : 'FAIL'}\n\n${r.steps.map((s) => `- ${s.ok ? 'pass' : '**FAIL**'}: ${s.name}${s.error ? `: ${s.error}` : ''}`).join('\n')}\n\n`);
}
console.log(ok ? 'smoke: PASS' : 'smoke: FAIL');
process.exitCode = ok ? 0 : 1;
