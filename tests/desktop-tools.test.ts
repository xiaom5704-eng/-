import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadDesktopTools } from '../scripts/desktop-tools.mjs';

test('Desktop tooling is optional and resolves from its own install before legacy root packages', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'medsafe-desktop-tools-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('medsafe-desktop-tools-'));
    rmSync(root, { recursive: true, force: true });
  });
  assert.throws(() => loadDesktopTools(root), /npm run electron:setup/);
  function packageFiles(base: string, name: string, entries: Record<string, string>) {
    const target = path.join(root, base, 'node_modules', name); mkdirSync(target, { recursive: true });
    for (const [file, content] of Object.entries(entries)) writeFileSync(path.join(target, file), content);
  }
  packageFiles('', 'electron', { 'package.json': '{"version":"0.0.0"}', 'index.js': 'module.exports="legacy";' });
  packageFiles('electron', 'electron', { 'package.json': '{"version":"41.10.7"}', 'index.js': 'module.exports="synthetic-desktop-binary";' });
  packageFiles('electron', 'electron-builder', { 'cli.js': '// synthetic CLI, not executed' });
  packageFiles('electron', 'node-abi', { 'index.js': 'exports.getAbi=()=>"145";' });
  const tools = loadDesktopTools(root);
  assert.equal(tools.binary, 'synthetic-desktop-binary'); assert.equal(tools.version, '41.10.7');
  assert.equal(tools.builder, path.join(root, 'electron/node_modules/electron-builder/cli.js'));
  assert.equal(tools.getAbi('41.10.7', 'electron'), '145');
});
