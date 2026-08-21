#!/usr/bin/env node
// expense-intake/scripts/onboard-client.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig, onboardClient, buildConsentCheckSql, parseConsentedPhonesFromWranglerJson } from '../src/onboarding.js';

const D1_DATABASE_NAME = 'expense-intake-db';
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

function runWranglerWithSql(sql, { local }) {
  const tmpFile = path.join(os.tmpdir(), `onboard-client-${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf8');
  try {
    // shell: true is required on Windows to resolve npx.cmd (execFileSync('npx', ...)
    // without it fails with ENOENT, since Windows won't spawn a .cmd shim directly without
    // going through a shell). Arguments aren't auto-escaped under shell: true, so the file
    // path is quoted explicitly in case a temp directory ever contains a space.
    const args = ['wrangler', 'd1', 'execute', D1_DATABASE_NAME, local ? '--local' : '--remote', `--file="${tmpFile}"`];
    execFileSync('npx', args, { stdio: 'inherit', cwd: PROJECT_ROOT, shell: true });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

// Same temp-file approach as runWranglerWithSql above (and for the same reason: unescaped
// shell:true args on Windows), but captures stdout instead of inheriting it, since this is a
// read whose JSON result the caller needs back.
function queryWranglerWithSql(sql, { local }) {
  const tmpFile = path.join(os.tmpdir(), `onboard-client-query-${Date.now()}.sql`);
  fs.writeFileSync(tmpFile, sql, 'utf8');
  try {
    const args = ['wrangler', 'd1', 'execute', D1_DATABASE_NAME, local ? '--local' : '--remote', `--file="${tmpFile}"`, '--json'];
    return execFileSync('npx', args, { cwd: PROJECT_ROOT, shell: true, encoding: 'utf8' });
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function queryConsentedPhones(phoneNumbers, { local }) {
  if (phoneNumbers.length === 0) return [];
  const sql = buildConsentCheckSql(phoneNumbers);
  const output = queryWranglerWithSql(sql, { local });
  return parseConsentedPhonesFromWranglerJson(output);
}

async function main() {
  const [configPath, serviceAccountPath, ...rest] = process.argv.slice(2);
  const local = rest.includes('--local');

  if (!configPath || !serviceAccountPath) {
    console.error('Usage: node scripts/onboard-client.js <config.json> <service-account.json> [--local]');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  validateConfig(config);
  const serviceAccountJson = fs.readFileSync(serviceAccountPath, 'utf8');

  const { housesWithSheets } = await onboardClient(config, {
    serviceAccountJson,
    runWrangler: (sql) => runWranglerWithSql(sql, { local }),
    queryConsentedPhones: (phoneNumbers) => queryConsentedPhones(phoneNumbers, { local }),
  });

  console.log(`\nOnboarded ${config.businessName}:`);
  for (const house of housesWithSheets) {
    console.log(`  ${house.nickname || house.address}: https://docs.google.com/spreadsheets/d/${house.googleSheetId}`);
  }
  console.log(`\nNext step: point ${config.twilioNumber}'s messaging webhook at the deployed Worker's /sms route.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
