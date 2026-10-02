import { registerGroundedLsp } from '../../index.ts';
import { createRustLauncher } from '../../rust-launch.ts';
const [root, directory] = process.argv.slice(2);
const hooks = new Map();
let tool;
registerGroundedLsp({
  on(name, handler) { hooks.set(name, handler); },
  registerTool(value) { tool = value; },
  registerCommand() {},
}, { launchRust: createRustLauncher({ directory }), clientOptions: { stopTimeouts: { shutdown: 100, exit: 80, term: 80, kill: 80 } } });
const ctx = { cwd: root, isProjectTrusted: () => false };
await hooks.get('session_start')({}, ctx);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await hooks.get('session_shutdown')({}, ctx);
}
process.on('message', async ({ id, params }) => {
  try {
    if (params.action === 'fixture-stop') {
      await stop();
      process.send({ id, result: 'closed' }, () => process.exit(0));
    } else {
      const result = await tool.execute('fixture', params, undefined, undefined, ctx);
      process.send({ id, result });
    }
  } catch (error) { process.send({ id, error: String(error) }); }
});
process.on('SIGTERM', async () => { await stop(); process.exit(0); });
setTimeout(async () => { await stop(); process.exit(0); }, 25_000);
process.send({ ready: true });
