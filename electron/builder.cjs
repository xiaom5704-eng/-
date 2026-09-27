const path = require('node:path');
const root = path.resolve(__dirname, '..');
module.exports = {
  appId: 'com.medsafe.ai', productName: '智慧醫療助理',
  electronVersion: require('electron/package.json').version,
  electronDist: path.join(root, 'node_modules/electron/dist'),
  directories: { app: 'release/app', output: 'release/windows' },
  files: ['dist/**/*', 'dist-server/**/*', 'electron/*.cjs', 'electron/loading.html', 'package.json'],
  extraResources: [{ from: 'release/seed', to: 'medsafe-data' }],
  asarUnpack: ['**/*.node', '**/*.dll', '**/onnxruntime-node/bin/**'],
  // Native modules are prepared explicitly in release/app; builder's workspace walk also visits the web app.
  npmRebuild: false,
  win: { target: 'nsis', icon: 'public/favicon.ico', artifactName: 'MedSafe-${version}-Setup.${ext}', signAndEditExecutable: false },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false, deleteAppDataOnUninstall: false },
};
