// Deploys the connector and the built Magic Mirror app to Cloudflare. Used by `npm run deploy`
// on your PC and by the GitHub workflow on every push to main.
//
// It finds (or creates) the KV namespace "magic-mirror-oauth", writes wrangler.deploy.json with
// its id, and deploys with that, so wrangler.jsonc stays free of account-specific ids.
// Needs a Cloudflare login (`npx wrangler login`) or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const WIN = process.platform === 'win32';
const wrangler = (args, inherit = false) =>
  execFileSync(WIN ? 'npx.cmd' : 'npx', ['wrangler', ...args], { cwd: here, encoding: 'utf8', shell: WIN, stdio: ['ignore', inherit ? 'inherit' : 'pipe', 'inherit'] });

if (!existsSync(join(here, '..', 'dist', 'index.html'))) {
  console.error('The app isn\'t built yet: run "npm run build" in the repo root first.');
  process.exit(1);
}

const NAME = 'magic-mirror-oauth';
const list = () => {
  const out = wrangler(['kv', 'namespace', 'list']);
  return JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
};
let ns = list().find((n) => n.title === NAME);
if (!ns) {
  console.log(`Creating KV namespace ${NAME}…`);
  wrangler(['kv', 'namespace', 'create', NAME]);
  ns = list().find((n) => n.title === NAME || n.title.endsWith(NAME));
  if (!ns) throw new Error(`Created ${NAME} but couldn't find it again`);
}

// wrangler.jsonc has only whole-line // comments, so dropping those lines leaves plain JSON.
const config = JSON.parse(readFileSync(join(here, 'wrangler.jsonc'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'));
config.kv_namespaces = config.kv_namespaces.map((k) => (k.binding === 'OAUTH_KV' ? { ...k, id: ns.id } : k));
writeFileSync(join(here, 'wrangler.deploy.json'), JSON.stringify(config, null, 2));

wrangler(['deploy', '-c', 'wrangler.deploy.json', ...process.argv.slice(2)], true);
