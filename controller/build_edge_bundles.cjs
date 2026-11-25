const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

// Only the static, secret-free bundled route DATA is dictionary encoded; no dynamic code loading/eval.
// Auth, validators and handlers remain the reviewed Supabase sources.
const root = path.resolve(__dirname, '..');
const routes = JSON.parse(fs.readFileSync(path.join(__dirname, 'default-routes.json'), 'utf8'));
const labels = [...new Set(Object.values(routes).flat())];
const roles = [...new Set(Object.keys(routes).filter(k => k.startsWith('mode:')).map(k => k.split(':')[2]))];
const modes = [...new Set(Object.keys(routes).filter(k => k.startsWith('mode:')).map(k => k.split(':')[1]))];
const utilities = Object.keys(routes).filter(k => k.startsWith('utility:')).map(k => k.split(':')[1]);
const indexed = modes.map(mode => roles.map(role => routes[`mode:${mode}:${role}`].map(label => labels.indexOf(label))));
const utilityRows = utilities.map(name => routes[`utility:${name}`].map(label => labels.indexOf(label)));
const reconstructed = Object.fromEntries([
  ...modes.flatMap((mode, mi) => roles.map((role, ri) => [`mode:${mode}:${role}`, indexed[mi][ri].map(i => labels[i])])),
  ...utilities.map((name, ui) => [`utility:${name}`, utilityRows[ui].map(i => labels[i])]),
]);
if (JSON.stringify(reconstructed) !== JSON.stringify(routes)) throw Error('Route dictionary encoding mismatch');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'adarsh-edges-'));
const sharedDir = path.join(temp, '_shared');
fs.mkdirSync(sharedDir);
let shared = fs.readFileSync(path.join(root, 'supabase/functions/_shared/controller.ts'), 'utf8');
const start = shared.indexOf('const chain =');
const end = shared.indexOf('const routePattern =');
if (start < 0 || end <= start) throw Error('Reviewed source data boundaries not found');
const data = `const _labels = ${JSON.stringify(labels)};\nconst _roles = ${JSON.stringify(roles)};\nconst _modes = ${JSON.stringify(modes)};\nconst _utility = ${JSON.stringify(utilities)};\nconst _mi = ${JSON.stringify(indexed)};\nconst _ui = ${JSON.stringify(utilityRows)};\nexport const BUNDLED_ROUTE_CHAINS: Readonly<Record<string, readonly string[]>> = Object.fromEntries([\n..._modes.flatMap((mode, mi) => _roles.map((role, ri) => [\`mode:\${mode}:\${role}\`, _mi[mi][ri].map(i => _labels[i])])),\n..._utility.map((name, ui) => [\`utility:\${name}\`, _ui[ui].map(i => _labels[i])])\n]);\n\n`;
shared = shared.slice(0, start) + data + shared.slice(end);
fs.writeFileSync(path.join(sharedDir, 'controller.ts'), shared);
const esbuild = process.argv[2];
if (!esbuild || !fs.existsSync(esbuild)) throw Error('Usage: node controller/build_edge_bundles.cjs /absolute/path/to/esbuild');
fs.mkdirSync(path.join(__dirname, 'edge-bundles'), { recursive: true });
for (const name of ['controller-admin', 'controller-device']) {
  const folder = path.join(temp, name);
  fs.mkdirSync(folder);
  fs.copyFileSync(path.join(root, `supabase/functions/${name}/index.ts`), path.join(folder, 'index.ts'));
  execFileSync(esbuild, [path.join(folder, 'index.ts'), '--bundle', '--minify', '--format=esm', '--target=es2022', '--external:npm:*', `--outfile=${path.join(__dirname, `edge-bundles/${name}.min.js`)}`], { stdio: 'inherit' });
}
fs.rmSync(temp, { recursive: true, force: true });
console.log(`Verified ${Object.keys(routes).length} exact static route chains; self-contained Edge source built.`);
