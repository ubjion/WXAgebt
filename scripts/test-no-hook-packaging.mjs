import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import deployment from '../apps/console-desktop/deployment.cjs';
const root = path.resolve(import.meta.dirname, '..');
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-no-hook-package-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  return { base, write };
}
test('bootstrap prepares model runtimes without a matching WeChat client or Hook payload', async t => {
  const { base, write } = fixture(t);
  write('resources/project/deployment.json', { version: 'fixture', dshBundled: false, files: ['config/wechatagent.example.json'] });
  write('resources/project/config/wechatagent.example.json', { runtime: { python: 'python', dshDesktop: '' } });
  write('resources/runtime/python/python.exe', 'python'); write('resources/runtime/node.exe', 'node');
  const result = await deployment.bootstrapDeployment(path.join(base, 'resources'), path.join(base, 'data'));
  assert(fs.existsSync(result.python)); assert(fs.existsSync(result.node));
  assert(!fs.existsSync(path.join(result.root, 'state/hook')));
});
test('bootstrap leaves legacy Hook backups, existing keys and model configuration untouched', async t => {
  const { base, write } = fixture(t);
  write('resources/project/deployment.json', { version: 'fixture', dshBundled: false, files: [] });
  write('resources/runtime/python/python.exe', 'python'); write('resources/runtime/node.exe', 'node');
  const config = { runtime: { python: 'custom-python', dshDesktop: 'custom-model' }, hook: { legacy: true } };
  write('data/workspace/config/wechatagent.json', config);
  const keep = ['state/hook/native/version.dll', 'state/hook/native/build.previous.json', 'state/weflow/WeFlow-config.json'];
  for (const name of keep) write('data/workspace/' + name, 'preserved-' + name);
  await deployment.bootstrapDeployment(path.join(base, 'resources'), path.join(base, 'data'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'data/workspace/config/wechatagent.json'))), config);
  for (const name of keep) assert.equal(fs.readFileSync(path.join(base, 'data/workspace', name), 'utf8'), 'preserved-' + name);
});
test('Hook configuration rejects immediately without importing setup or changing config', t => {
  const { base, write } = fixture(t);
  write('scripts/configure-hook.mjs', fs.readFileSync(path.join(root, 'scripts/configure-hook.mjs'), 'utf8'));
  write('scripts/project-config.mjs', `import fs from 'node:fs'; export const projectRoot=${JSON.stringify(base)}; export function prepare(){fs.writeFileSync(projectRoot+'/called','bad');}`);
  write('config/wechatagent.json', { runtime: { sender: 'database-only' } });
  const before = fs.readFileSync(path.join(base, 'config/wechatagent.json'));
  const result = spawnSync(process.execPath, [path.join(base, 'scripts/configure-hook.mjs')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /HOOK_DISABLED/);
  assert.deepEqual(fs.readFileSync(path.join(base, 'config/wechatagent.json')), before);
  assert(!fs.existsSync(path.join(base, 'config/wechatagent.pre-hook.json'))); assert(!fs.existsSync(path.join(base, 'called')));
});
test('Hook build rejects before preparing build or output directories', t => {
  const { base, write } = fixture(t);
  write('scripts/build-hook.ps1', fs.readFileSync(path.join(root, 'scripts/build-hook.ps1'), 'utf8'));
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(base, 'scripts/build-hook.ps1'), '-MsBuild', 'never-run', '-BuildDirectory', 'state/build', '-OutputDirectory', 'state/native'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /HOOK_DISABLED/); assert(!fs.existsSync(path.join(base, 'state')));
});
test('installer and runtime probes have no dependency on injection or key extraction artifacts', () => {
  const installer = fs.readFileSync(path.join(root, 'scripts/build-installer.mjs'), 'utf8');
  assert.doesNotMatch(installer, /verifyHookBuild|state\/hook|vendor[\'", /]+hook[\'"/]|wx_key\.dll|addTree\('scripts\/native-hook'\)|addTree\('components\/WeChat-Hook'/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'scripts/check-runtime.py'), 'utf8'), /wx_key\.dll|Reader key component missing/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'scripts/setup.ps1'), 'utf8'), /For WeChat-Hook, build/);
});
