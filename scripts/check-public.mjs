// Checks the index, not the working tree. Never prints a matched secret value.
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { maxBuffer: 16_000_000 });
const files = git('ls-files', '--cached', '-z').toString().split('\0').filter(Boolean);
const patterns = [
  ['bot credential', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/],
  ['API credential', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/],
  ['OAuth secret', /\bGOCSPX-[A-Za-z0-9_-]{12,}/],
  ['access credential', /\b(?:ghp_|github_pat_|AKIA)[A-Za-z0-9_]{16,}/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  [
    'personal filesystem path',
    /(?:[A-Za-z]:[\\/](?:Users|Desktop)[\\/]|\/Users\/|\/home\/)[^\s"'`]+/,
  ],
];
const localValues = Object.entries(process.env)
  .filter(
    ([key, value]) =>
      /(?:TOKEN|SECRET|API_HASH|ENCRYPTION_KEY|OWNER_TELEGRAM_ID|GOOGLE_CLIENT_ID)$/.test(key) &&
      value &&
      value.length >= 6,
  )
  .map(([, value]) => value);
let failures = 0;
for (const file of files) {
  const blocked =
    /^(?:data|backups|node_modules|dist|coverage|src\/private)\//.test(file) ||
    (/(?:^|\/)\.env(?:$|\.)/.test(file) && file !== '.env.example') ||
    /\.(?:sqlite(?:-wal|-shm)?|db|session(?:-journal)?|pem|key|enc|har|trace|zip|pid|log)$/.test(
      file,
    ) ||
    /(?:client_secret|credentials|storage[-_]?state)[^/]*\.json$/i.test(file);
  if (blocked) {
    console.error('Blocked publication path: ' + file);
    failures++;
    continue;
  }
  const content = git('show', ':' + file).toString('utf8');
  for (const [label, pattern] of patterns)
    if (pattern.test(content)) {
      console.error(file + ': ' + label);
      failures++;
    }
  if (localValues.some((value) => content.includes(value))) {
    console.error(file + ': local configuration value');
    failures++;
  }
}
if (failures) {
  console.error('Publication check failed: ' + failures + ' finding(s).');
  process.exitCode = 1;
} else
  console.log(
    'Publication check passed: ' +
      files.length +
      ' staged files. Review the diff and commit identity before publishing.',
  );
