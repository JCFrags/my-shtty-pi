const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { app, BrowserWindow } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const { configureBrowserSession } = require('../../dist/page/browser-session.js');
const { controlBlocking } = require('../../dist/blocking/session.js');
const { BlockingProfile, siteHostname } = require('../../dist/blocking/profile.js');
const { parseBlockingRequest } = require('../../dist/blocking/types.js');
const { BrowserController } = require('../../dist/page/controller.js');
const { TabManager } = require('../../dist/session/tabs.js');
const { BrowserControl } = require('../../dist/agent/control.js');

const root = fs.mkdtempSync(path.join(tmpdir(), 'terminal-browser-blocking-'));
app.setPath('userData', root);
app.commandLine.appendSwitch('disable-gpu');
const windows = [];
let manager;
let adRequests = 0;
const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', req.url.endsWith('.js') ? 'application/javascript' : 'text/html');
  if (req.url.startsWith('/page-ads/assets/')) adRequests++;
  res.end(req.url.endsWith('.js') ? 'window.loaded = (window.loaded || 0) + 1' :
    '<script src="/page-ads/assets/banner.js"></script><script src="/ordinary.js"></script><body>Blocking fixture</body>');
});
const command = (window, action, site) => controlBlocking(window.webContents, parseBlockingRequest(action, site));
const status = window => command(window, 'status');
const create = partition => {
  const session = configureBrowserSession(partition);
  // Configuration is idempotent and must not detach the guard on later calls.
  assert.equal(configureBrowserSession(partition), session);
  const window = new BrowserWindow({ show: false, webPreferences: {
    session, offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  windows.push(window);
  return window;
};

(async () => {
  assert.equal(process.versions.electron, '43.3.0');
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const a = create('blocking-a');
  const peer = create('blocking-a');
  const b = create('blocking-b');
  const load = async (window, expected) => {
    await window.loadURL(base);
    assert.equal(await window.webContents.executeJavaScript('window.loaded'), expected);
  };
  await load(a, 1);
  assert.equal(adRequests, 0);
  assert.equal(status(a).diagnostics.blocked, 1);
  assert.equal(status(peer).diagnostics.blocked, 0);
  assert.equal(status(b).diagnostics.blocked, 0);
  assert.deepEqual(status(a).diagnostics.recent, [{ host: '127.0.0.1', type: 'script' }]);
  command(a, 'disable');
  assert.equal(status(peer).enabled, false); // Settings belong to the profile.
  assert.equal(status(b).enabled, true);
  await load(a, 2);
  await load(b, 1);
  assert.equal(adRequests, 1);
  command(a, 'enable');
  command(a, 'allow-site');
  assert.equal(status(a).siteAllowed, true);
  assert.equal(status(a).effective, false);
  await load(a, 2);
  await load(b, 1);
  const saved = new BlockingProfile(path.join(a.webContents.session.storagePath, 'terminal-browser-blocking'));
  assert.equal(saved.status(a.webContents).siteAllowed, true);
  assert.equal(saved.status(a.webContents).filters.cache, 'hit');
  assert.deepEqual(saved.status(a.webContents).exceptions, ['127.0.0.1']);
  assert.equal(siteHostname('https://EXAMPLE.com.:8443/private?token=ignored'), 'example.com');
  assert.notEqual(siteHostname('sub.example.com'), siteHostname('example.com'));
  const credentialUrl = new URL('https://example.invalid');
  credentialUrl.username = 'synthetic'; credentialUrl.password = 'synthetic';
  assert.throws(() => siteHostname(credentialUrl.href), /credentials/);
  assert.throws(() => parseBlockingRequest('status', 'example.com'), /only valid/);
  command(a, 'block-site');
  await load(a, 1);
  assert.equal(command(a, 'reload').filters.cache, 'rebuilt');
  assert.equal(command(a, 'clear-diagnostics').diagnostics.blocked, 0);
  // Diagnostics remain bounded and omit paths, queries, referrers and filter text.
  await a.webContents.executeJavaScript(`Promise.all(Array.from({length:40}, (_,i) => new Promise(resolve => { const s = document.createElement('script'); s.onload = s.onerror = () => resolve(null); s.src = '/page-ads/assets/secret-' + i + '.js?token=private'; document.body.append(s); })))`);
  assert.equal(status(a).diagnostics.recent.length, 32);
  assert.equal(status(a).diagnostics.blocked, 40);
  assert(!JSON.stringify(status(a).diagnostics).includes('private'));
  const local = path.join(root, 'local.html');
  fs.writeFileSync(local, '<body>Local file guard</body>');
  for (const action of ['enable', 'disable']) {
    command(a, action);
    await a.loadFile(local);
    assert.equal(await a.webContents.executeJavaScript('fetch(location.href).then(() => false, () => true)'), true);
  }
  // The same guard also remains active when a network site is excepted.
  command(a, 'enable'); command(a, 'allow-site', base);
  await a.loadFile(local);
  assert.equal(await a.webContents.executeJavaScript('fetch(location.href).then(() => false, () => true)'), true);
  assert.equal(await a.webContents.executeJavaScript('document.body.textContent'), 'Local file guard');
  const control = new BrowserControl();
  const surface = () => ({ clear() {}, close() {}, present(frame) { frame.released?.(); } });
  manager = new TabManager({
    createController: (url, visible, onState) => new BrowserController(surface(), surface(), surface(),
      { x: 0, y: 0, width: 800, height: 600, scale: 1 }, url, {
        cwd: root, background: '#222222', visible, partition: 'blocking-controller', tabsAsPopups: false,
        clipboardRead: false, sessionKey: 'blocking-fixture', appTabId: null,
      }, onState),
    onActivated() {}, onActiveState() {}, onCursorChanged() {}, onDevtoolsChanged() {}, onDevtoolsAction() {}, onPageMenu() {},
    onTabsChanged() {}, requestAgentRender() {}, onTabOpened() {}, onTabClosed(id) { manager.removeClosed(id); },
    tabSwitchAllowed: () => true, agentTabSwitchAllowed: () => true, requestRender() {},
  }, 'about:blank', control);
  const tab = manager.create(base);
  for (let i = 0; i < 300 && (tab.state.loading || tab.state.url !== base + '/'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(tab.state.loading, false);
  assert.equal(manager.blocking(tab.id, { action: 'status' }).contextId, tab.id);
  assert.throws(() => manager.blocking(999, { action: 'status' }), /no context/);
  assert.throws(() => manager.blocking(tab.id, { action: 'disable' }), /epoch/);
  const oldEpoch = control.controlEpoch;
  control.pause(oldEpoch);
  assert.equal(manager.blocking(tab.id, { action: 'status' }).enabled, true);
  assert.throws(() => manager.blocking(tab.id, { action: 'disable' }, control.controlEpoch), /paused/);
  control.resume(control.controlEpoch);
  assert.throws(() => manager.blocking(tab.id, { action: 'disable' }, oldEpoch), /epoch/);
  assert.equal(manager.blocking(tab.id, { action: 'disable' }, control.controlEpoch).enabled, false);
  manager.stopAll(); manager = null;
  console.log(JSON.stringify({ result: 'PASS', electron: process.versions.electron, engine: status(a).engine,
    offscreen: true, sandbox: true, profileIsolation: true, contextDiagnosticsIsolation: true,
    savedSettingsAndCache: true, siteException: true, fileXhrGuard: ['enabled', 'disabled', 'excepted'],
    diagnosticsLimit: 32, nativeControllerAndEpoch: true }));
  for (const window of windows) window.destroy();
  server.close(); app.quit();
})().catch(error => {
  console.error(error);
  manager?.stopAll();
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  server.close(); app.exit(1);
});
