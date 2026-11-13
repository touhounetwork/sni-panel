import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const baseline = { os: 'ubuntu-24.04', node: 'v22.23.3', pnpm: '10.28.1', go: 'go1.24.13' };
export const groups = {
  prepare: [['pnpm', 'check:versions'], ['pnpm', 'test:release-notes'], ['node', '--test', 'scripts/release/protocol.test.mjs', 'scripts/release/cli.test.mjs'], ['pnpm', 'exec', 'tsc', '--noEmit'], ['pnpm', 'build']],
  language: [['pnpm', 'test:i18n']],
  docs: [['pnpm', 'docs:build'], ['node', 'scripts/release/verify-docs.mjs']],
  performance: [['node', '--import', 'tsx', '--test', '--test-concurrency=1', 'server/sniBatchEdit.performance.test.ts']],
  mysql: [['pnpm', 'test:database-upgrade']],
  agent: [['bash', 'scripts/release/verify-agent.sh']],
};
// Functional checks: every test file from package.json test scripts runs exactly
// once (several scripts list the same files), split into parallel CI shards.
// Groups with their own environment run elsewhere: i18n (language), MySQL,
// the serial SNI batch benchmark (performance) and the real-browser suite.
export const FUNCTIONAL_SHARDS = 4;
const FUNCTIONAL_EXCLUDED = new Set(['test:release-notes', 'test:i18n', 'test:database-upgrade', 'test:sni-performance', 'test:web-browser']);
export function functionalTestFiles(scripts = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts) {
  const files = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!(name.startsWith('test:') || name === 'pretest:server') || FUNCTIONAL_EXCLUDED.has(name)) continue;
    for (const file of cmd.match(/\b(?:server|client|shared|scripts)\/\S+?\.test\.(?:ts|tsx|mjs)\b/g) || []) if (!files.includes(file)) files.push(file);
  }
  // Not listed in any package script; previously run on its own.
  if (!files.includes('server/tunnelProbeReporting.test.ts')) files.push('server/tunnelProbeReporting.test.ts');
  return files;
}
const functionalFiles = functionalTestFiles();
for (let shard = 1; shard <= FUNCTIONAL_SHARDS; shard++) {
  groups[`functional-${shard}`] = [
    // Shell integration checks otherwise report SKIP when jq is absent.
    ['bash', '-c', 'command -v jq >/dev/null || { echo "Functional checks require jq; install jq before continuing" >&2; exit 1; }'],
    // Startup integration tests read the production client build.
    ['pnpm', 'build'],
    ['node', '--import', 'tsx', '--test', `--test-shard=${shard}/${FUNCTIONAL_SHARDS}`, ...functionalFiles],
  ];
}
const command = (cmd, args = []) => spawnSync(cmd, args, { encoding: 'utf8' });
export function verify(selected = 'all') {
  const requested = selected === 'all' ? Object.keys(groups) : selected.split(',');
  for (const name of requested) if (!groups[name]) throw new Error(`Unknown check group: ${name}`);
  const commit = command('git', ['rev-parse', 'HEAD']).stdout.trim();
  const environment = { platform: process.platform, arch: process.arch, node: process.version,
    pnpm: command('pnpm', ['--version']).stdout.trim(), go: command('go', ['version']).stdout.trim(),
    os: fs.existsSync('/etc/os-release') ? fs.readFileSync('/etc/os-release', 'utf8') : process.platform };
  if (process.env.CI === 'true') {
    if (environment.node !== baseline.node || environment.pnpm !== baseline.pnpm || !environment.go.includes(baseline.go + ' ') || !environment.os.includes('VERSION_ID="24.04"') || !environment.os.includes('ID=ubuntu')) {
      throw new Error(`Validation baseline mismatch: ${JSON.stringify(environment)}`);
    }
  }
  fs.mkdirSync('.release/checks', { recursive: true });
  for (const name of requested) {
    if (name === 'mysql' && !process.env.FORWARDX_TEST_MYSQL_URL) throw new Error('MySQL integration URL is required; a skipped integration test cannot pass the release gate');
    if (name === 'agent' && (process.platform !== 'linux' || process.arch !== 'x64')) throw new Error('Agent release fixtures require Linux amd64, matching the released binaries');
    const sourceClean = command('git', ['status', '--porcelain', '--untracked-files=normal']).stdout.trim() === '';
    const record = { schema: 1, group: name, commit, sourceClean, environment, baseline, status: 'running', commands: [] };
    const recordFile = `.release/checks/${name}.json`;
    const save = () => fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n');
    save();
    for (const [index, args] of groups[name].entries()) {
      console.log(`\n[${name}] ${args.join(' ')}`);
      const started = Date.now();
      const log = fs.openSync(`.release/checks/${name}-${index}.log`, 'w');
      const result = spawnSync(args[0], args.slice(1), { stdio: ['ignore', log, log], env: {
        ...process.env, npm_config_enable_pre_post_scripts: 'false', FORWARDX_DNS_RACE_REPEATS: '100',
      } });
      fs.closeSync(log);
      // Keep the full diagnostic log even when the first assertion fails.
      process.stdout.write(fs.readFileSync(`.release/checks/${name}-${index}.log`));
      record.commands.push({ args, status: result.status, signal: result.signal, elapsedMs: Date.now() - started });
      if (result.status !== 0) {
        record.status = 'failed'; save();
        throw new Error(`Check failed without retry: ${name}: ${args.join(' ')} (${result.error || result.status})`);
      }
      save();
    }
    record.status = 'passed'; save();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) verify(process.argv[2]);
