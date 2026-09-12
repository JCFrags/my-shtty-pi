#!/usr/bin/env node
// Exact selected package identity, independent of branch ancestry and root catalogs.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHRONO_HISTORICAL_BASELINE = Object.freeze({
  commit: 'ad23f0b71ee473d33aff26d367459e76d208c631',
  tree: '14dbd0cb89a8b66f4225e2932503b62a808d9be1',
  files: 278,
  version: '2.0.4',
});
export const CHRONO_BASELINE = Object.freeze({
  "commit": "ae0d72660b7b2dfa350a9663141879f35a3e8b6b",
  "upstreamTree": "a84ccd75001dd16f212cc0cda85547d9a9f273a9",
  "tree": "c317f4851100b072ff84a5d78dd0a7fadc77131f",
  "files": 427,
  "maps": 134,
  "package": "packages/pi-chrono-compaction",
  "version": "2.0.30",
  "integrationDifferences": [
    {
      "path": "DEPLOYED.sha256",
      "upstreamSha256": "3954d79d5faa1bb68e189a9db2fc799f0b4659715a2d73c91df2d7e332f3d627",
      "integratedSha256": "0049283a5e12da8a97c9c6c1db38212ca1d45b98d023463de5459264aaf39a8e"
    },
    {
      "path": "README.md",
      "upstreamSha256": "587b68f55d7770db1e226224804aa29d40d136a601d20dbe49c62da989405148",
      "integratedSha256": "cc6333b580b5a2078b4b24e3d4c0dcdb88e6a08851b830fca6b98d4425b8ba17"
    },
    {
      "path": "dist/src/context-composer.js",
      "upstreamSha256": "a8f229ffab1214785dee39ecccb86b661474d9490aca9bb36eb2b4cc1027cdfa",
      "integratedSha256": "85f0e3c4822e44a9bb5630910cd553ef8d4c3b5b88fa4009823a146238573e0e"
    },
    {
      "path": "dist/src/episode-rollup-store.js",
      "upstreamSha256": "b3829c50714e79d5ae308f5007e95b5f0ef66bb837682f686d3e252b847fb4ad",
      "integratedSha256": "cc64b9b61d8ee496b3dacca2e9e4b34acca334f6d592b23745f6c8a6816446cb"
    },
    {
      "path": "dist/src/episode-state-contract.js",
      "upstreamSha256": "2de30bcfeeaf1be90d335dfc5243ff7d284200a9398920004e08dcbcfa73fb85",
      "integratedSha256": "277e1f3676ce615a588daff25a909f61a3d1847485438d48c5a717f5acedf80b"
    },
    {
      "path": "dist/src/episode-state-store.js",
      "upstreamSha256": "4feba6d1cd5d0c7e51cfb9dc696bd5eef807339a36fb5da8ae720e93b7a9562b",
      "integratedSha256": "0b9261427a9ddfbd8b2121a2219f405122bc892fb9f7ee36c4284eb51541308e"
    },
    {
      "path": "dist/src/history-search-adapter.js",
      "upstreamSha256": "4de4670ea409416c241ac73422700d819dd700bb33d2543c484d1300ba559ade",
      "integratedSha256": "79a77d87c652351800b339ac8568d6c2c7752240eddb3b46c6d354cf24300c75"
    },
    {
      "path": "dist/src/logical-session-contract.js",
      "upstreamSha256": "4f8151e2e739942e28e8e50828f9f8426b2a756dcbc24a04306032bf13f02fde",
      "integratedSha256": "c4c6bdb464bcdccf6363d9b0978477c31d107475d7b4d96261499d2d568af221"
    },
    {
      "path": "dist/src/logical-session-integration.js",
      "upstreamSha256": "b92ed77386c2233c3ea2247f2b70cf247b7e0398c4aa8e38de95af6f0b0fada5",
      "integratedSha256": "b944af5271a78b9d6d736dda86f08df1e631985d966c8bb518b8ba9b102182c3"
    },
    {
      "path": "dist/src/logical-session-persistence.js",
      "upstreamSha256": null,
      "integratedSha256": "740eeb7bc32c2bea13c92442b6ae950661d6958a3ff4e552bec45590b866f140"
    },
    {
      "path": "dist/src/logical-session-rollover.js",
      "upstreamSha256": "6d4d4527778ed8a974094c8ff29a000802eee85fb7e1e125901f501cc43d0954",
      "integratedSha256": "4180d3d5040e8adfb77ae5344464b47ee3f9d1de71fbc55bb3042d4bd38c7816"
    },
    {
      "path": "dist/src/logical-session-routing.js",
      "upstreamSha256": "8b1030c1061ed33be19e7c8ec2f796c9e39b4a43ea08bfaa3b480ca626a1ea52",
      "integratedSha256": "0d5775063399b430a1fbc8300fa7bf95b9a9585d32545473459cbb8a6ff57391"
    },
    {
      "path": "dist/src/logical-session-status.js",
      "upstreamSha256": null,
      "integratedSha256": "ead60c7c950f064bb05064d30bddb4e04204102b871958bc9f0a7403e53c3215"
    },
    {
      "path": "dist/src/logical-session-store.js",
      "upstreamSha256": "21ab5e9e43ff3bf5bb0589c59caa54d1f7fb4bb04ed975c7de157c28e2dcfdfd",
      "integratedSha256": "55019527621ac814fae81c22e15c2de6ae4ef09c8e482570804984b319e0b7fe"
    },
    {
      "path": "dist/src/pi-extension.js",
      "upstreamSha256": "fd73ff49e06a2e3da1899b62bed11a2e90aac0a98f6b4b6dba4d6f7af728ac7c",
      "integratedSha256": "664c84f511c7ecd0f5f44e1fc6d8348688ff29bf28c15050fc179f09935333f8"
    },
    {
      "path": "dist/src/runtime-identity.js",
      "upstreamSha256": null,
      "integratedSha256": "0531e5f884a8b09b09ffa04d90a456e61061420fe6e7930ce7d6611c93a919cd"
    },
    {
      "path": "dist/src/search-v3-store.js",
      "upstreamSha256": "48be2400c11556abbf54e9638db56f2e0877ed5ce9918425471f5e7fcb6572cb",
      "integratedSha256": "aeb11dab1f3e3b288fae3c466c3cffd73d0d33cc40f868281a031a7f647c0ffc"
    },
    {
      "path": "dist/src/session-migration.js",
      "upstreamSha256": null,
      "integratedSha256": "ddc1138c3a046c05d999a24da1600d3ea2f85538f3720b3bb7d594dd57eff9e9"
    },
    {
      "path": "dist/src/user-config.js",
      "upstreamSha256": "fc4e3a512a147192328f57aada22219469c16ec65c27b9ee019d1a57aa6f03c0",
      "integratedSha256": "01f4f6f113b8c9cffd23db3873e04e9a2a5344494c11e5e26ac8c300e822f936"
    },
    {
      "path": "package-lock.json",
      "upstreamSha256": "42024d0876d7a367509bb86b11601c3ede4cebb7282cfb14b803d42ce60114d9",
      "integratedSha256": "36c55c89ec4541a28ddff1176f8f25fcd1783f153ce6eb5383935cf5d4eb1659"
    },
    {
      "path": "package.json",
      "upstreamSha256": "18e98ac6afc84a504df0c3bee20690941c2a60390f74b0d413603b0b2cf717e4",
      "integratedSha256": "48bedec1c5ce1c67d4058aafd976d2aea40bf4516cd3abe5cc3dcf9c057f2e1d"
    },
    {
      "path": "scripts/m11-logical-pi-qualification.mjs",
      "upstreamSha256": null,
      "integratedSha256": "22cf5c61d8ec3f39b3c2817f7bf9b2b646f55f900646b574c56bb4567bffe844"
    },
    {
      "path": "scripts/m11-scale-campaign.mjs",
      "upstreamSha256": null,
      "integratedSha256": "893e4f27b2070395736ab24eceafd572c099caada3f19ef56817345f2973e58f"
    },
    {
      "path": "scripts/m11-supplemental-faults.mjs",
      "upstreamSha256": null,
      "integratedSha256": "67ec9fb38180b3ba9f080c11f56858639173a215725971a1086cca14150c118d"
    },
    {
      "path": "src/context-composer.ts",
      "upstreamSha256": "de8542d97a3bd980208e1aa241961204e2feedf66b2a1bacffc71af0a3424258",
      "integratedSha256": "fe83f7f921c595b172200859de1e8e08ca18c76cef64f7b54aee0036600fa6b7"
    },
    {
      "path": "src/episode-rollup-store.ts",
      "upstreamSha256": "c751b0d9a9ad0a36e5562c7fa1b100f4e72bc83aa3cdb074e1b9afe5b2d7ea2e",
      "integratedSha256": "d499ab28e6094aa8695e55fddbd9dd128b9fa7e8b943d0b1ebbdca31fa1c184d"
    },
    {
      "path": "src/episode-state-contract.ts",
      "upstreamSha256": "837cd29803d0b452f503284e14f53db1547e78dbf10d1366eacdf45e3a510e47",
      "integratedSha256": "3e5c046e740f58e295c48f3aa00c1455a4a7305d665891fe212edf00a3a29300"
    },
    {
      "path": "src/episode-state-store.ts",
      "upstreamSha256": "3ba48f5e633617b6d2d3668b507408d8baec7f586338be23dc2b216c459e1dac",
      "integratedSha256": "eec3c3f7e18fb0519b6af600573131c433c02a9416d4e6ceaf9c3aee944ac03a"
    },
    {
      "path": "src/history-search-adapter.ts",
      "upstreamSha256": "e7fcc2a307258288650f219bb57ced340cb55fadc3a7a3ab00ae9e408ca8419a",
      "integratedSha256": "6b55bc0eaeb5d9b2c422a9fc4d767e05bba4004946dd9de888485ddd36863dd8"
    },
    {
      "path": "src/logical-session-contract.ts",
      "upstreamSha256": "5b83cd65c1c57e313fac543619d55f29f5ef009fa8e32a296ae01bf9d4834380",
      "integratedSha256": "2ebf47ef11133800daa735f109774522416ab643b42a749acb52d5daa8e0acf9"
    },
    {
      "path": "src/logical-session-integration.ts",
      "upstreamSha256": "a9ee8074c4522ce5382ee8496b5799895f009d9de3eb2311bb2d5540b60aa776",
      "integratedSha256": "6946c40d2e94676877f33fb1c9ebcb4151d3832ccf7eb28a717af955281e1fc6"
    },
    {
      "path": "src/logical-session-persistence.ts",
      "upstreamSha256": null,
      "integratedSha256": "b61a11eee6f577230c6ba76d3181ea93e53cd604500440b592941a9162deda50"
    },
    {
      "path": "src/logical-session-rollover.ts",
      "upstreamSha256": "94f8bd713c5cb40f44255f7497c7ab757fd920f740e09960caf5940cfedaf8a1",
      "integratedSha256": "ae4849e1dfa872f6caeba84f1590b7d57baa8dfc80f59d628023cdfc8016e249"
    },
    {
      "path": "src/logical-session-routing.ts",
      "upstreamSha256": "a11f7c0f46a2a40666c26d8006e19d3e2a0e3a20235eab182dde96cb786399a4",
      "integratedSha256": "6fd11510b6241819267206f7dc12d8e27bdc355cf2ee1c6486ff59a40e0747f6"
    },
    {
      "path": "src/logical-session-status.ts",
      "upstreamSha256": null,
      "integratedSha256": "46754e3bfc9b64ef2ae01baddbed883dd8fafcbd781a4c6f72f72f9f85fae3dc"
    },
    {
      "path": "src/logical-session-store.ts",
      "upstreamSha256": "422936b3460c256d954b57662cde101ae4183ce6c8a0a87e3a90d62b77df1864",
      "integratedSha256": "50c1d19245b8d807967e714671f09962b354250c8fa266b987cca81423961301"
    },
    {
      "path": "src/pi-extension.ts",
      "upstreamSha256": "5887ef236ee27480921f72e6b2fddb3987d2702492fc3a771d0c7f2056a3c48b",
      "integratedSha256": "e322f9373ca5f8bccbb25036743d4a08eaaf51b9c046606b6f95cddf7e6087cb"
    },
    {
      "path": "src/runtime-identity.ts",
      "upstreamSha256": null,
      "integratedSha256": "6feee6c4cca5229ee84acf7f4c68dda32b69f0f9749fa2cb15554dc7e2cb6581"
    },
    {
      "path": "src/search-v3-store.ts",
      "upstreamSha256": "3b35817d451dbfa9dbd757da7427e570b3bc8d4125bdd859752af17c298b8769",
      "integratedSha256": "5da026acda882e42d8c1e279f942a26949071a410a058e926ae3d99b6b270ded"
    },
    {
      "path": "src/session-migration.ts",
      "upstreamSha256": null,
      "integratedSha256": "b6bd6f6bbaf334b0c42d92dc5769a0ea3d5566f8451c8747ca9645e189489463"
    },
    {
      "path": "src/user-config.ts",
      "upstreamSha256": "76f4923bcfdb097284eca1e55a0c41227feaf14eed28ff5f696d478671099f63",
      "integratedSha256": "ce444784d5cbfd362609d9f8665af0579a58905a8863fbd940f6d69df8b58003"
    },
    {
      "path": "test/capsule-extension.test.ts",
      "upstreamSha256": "6070fcea5f49f22632d37d2853b6538b3c3daf41ff28608de002dda6b31d9902",
      "integratedSha256": "d0dd28fb1f7dbe71f945f52174284a5102730c1631228cb7d64230478bd3e37d"
    },
    {
      "path": "test/catalog-history-provenance.test.ts",
      "upstreamSha256": "37a10d10a33c1ad7bebfb082d1e3396782331924fae9ecbd76dcefd09a0e4bbb",
      "integratedSha256": "bdbd323f06ff4be86695c40e503c9dcc8d126950d53f6d6c52f3db1b545e1abd"
    },
    {
      "path": "test/catalog-lifecycle.test.ts",
      "upstreamSha256": "ad0ac9d641c5453c181fd954776062dd156b3ed208f8fa447c6e2872f1a2d8c4",
      "integratedSha256": "90d33f69ddd8a7f93b0e8113d283207bdb2814fef73fc3f6c45f35d7efa7632d"
    },
    {
      "path": "test/context-composer.test.ts",
      "upstreamSha256": "a80185196d6617fcddaaedc457b8babf3b0a8e941c891acff51700944af59ff2",
      "integratedSha256": "53897c1375c95c69362518542dbc8378254b0318f89d404f16a2e7058ea0f1e2"
    },
    {
      "path": "test/episode-state.test.ts",
      "upstreamSha256": "e26e4c3866c0fb6988168ac53d0d14e7637d6ef5a5519e3aaf1e08eb2e31bb24",
      "integratedSha256": "26603595257142664676c9c284d8588dfc2164265511df6e8e9f2f9c84c44e49"
    },
    {
      "path": "test/extension.test.ts",
      "upstreamSha256": "1d0247207b0dc2fc30e3b219c277d0f8ad4ffdf12e7be9d7f5ac11f782675c06",
      "integratedSha256": "81af3563dfcd0e1066a0c9ae78cf3f1b53c479170cdc50d85353ba1bd7ac19cf"
    },
    {
      "path": "test/history-search-adapter.test.ts",
      "upstreamSha256": "c025d07d72fd03778e3fe1b823a3d7519a977fac8d82670da1e6f51c95faf0f3",
      "integratedSha256": "f398d3456422f4173697bf03dd92cc46e3bee2d009b23f190b2f110b1c500e09"
    },
    {
      "path": "test/logical-session-rollover.test.ts",
      "upstreamSha256": "cc8ed24310a5ff9301a48ffda61fadb3301b59b560e4b194073bfb7a364d1fd8",
      "integratedSha256": "551997467c120eccf34e84caf8f3288275d4979c17e6e8a18fb600625e850081"
    },
    {
      "path": "test/m11-scale-campaign.test.ts",
      "upstreamSha256": null,
      "integratedSha256": "3361afb64b6059b1eae6298da8b31dff3d21405f43f070f5acba6e36beca416e"
    },
    {
      "path": "test/m11-supplemental-faults.test.ts",
      "upstreamSha256": null,
      "integratedSha256": "452c33e8171c316a145100f30447d1fe5e33c682701722ea5fc1a09f69f9ec2d"
    },
    {
      "path": "test/pinned-session-replacement.test.ts",
      "upstreamSha256": "5611f0e3a99631547679115638460f823f55d56a5d00d4d84f1e19f01035ec50",
      "integratedSha256": "e4b1640d4e00050424dece39642941ccefce9a77052ef4ac7b4683318777e428"
    },
    {
      "path": "test/search-v3-recovery.test.ts",
      "upstreamSha256": "7a90d84758b6ce111b90b6781fc6cc0571ad56fe17d5379d8591865c8a2a946a",
      "integratedSha256": "d2ae7c4054f51c67227441dadef6943dce534289655ed942bfda84c76378f404"
    },
    {
      "path": "test/session-migration.test.ts",
      "upstreamSha256": null,
      "integratedSha256": "b29977cd2f643a17a71cc82e770d1bd3b25085d924d8b568a7691a62d178efc7"
    },
    {
      "path": "test/v11-retention-gradient.test.ts",
      "upstreamSha256": "5bd633bef9ead93cde06046828d1a0211284fe1644c60481bca152162cf5ebb1",
      "integratedSha256": "f4426a29523a17941af4c3eeae6f3bcdb9014ceb978fb1745c7434cd02c98cf5"
    },
    {
      "path": "test/v2-extension-integration.test.ts",
      "upstreamSha256": "c36e5ee9d4a74ef4a2561a0bc6aa3aaae7c04c03671b8461df33fd1f9e0bce7a",
      "integratedSha256": "4c84ff547183b473284031d800a4945289d7c11e996bb03da7a32708c18348ba"
    },
    {
      "path": "test/worker-runtime.test.ts",
      "upstreamSha256": "d55227e12c9ce45e42b4703daf30b2966f95d1352cd442319ae01fd8fbf7fee0",
      "integratedSha256": "54ed55886810e4dbaf14625efc8a84aacc39a6f88009a71c1e7ea20821046b3b"
    }
  ]
});
const fail = code => { throw new Error(code); };
const objectHash = (kind, bytes) => createHash('sha1').update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');

// Git tree ordering compares directories with a trailing slash, and embeds raw
// object IDs. No Git writes, mutable branch names, or external inventory files.
function treeHash(entries) {
  const ordered = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
  return objectHash('tree', Buffer.concat(ordered.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.hash, 'hex')])));
}
function checkIdentity(tree, files, code) {
  if (tree !== CHRONO_BASELINE.tree || files !== CHRONO_BASELINE.files) fail(code);
  return { tree, files };
}
function inspectChronoFiles(packageRoot, generatedMaps = false) {
  let files = 0;
  const maps = [], javascript = [];
  function visit(directory, top = false) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('chrono-unsafe-tree');
    const entries = [];
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), info = lstatSync(path);
      // Only the package-root ignored dependency installation is outside the
      // release. Indexed node_modules is still rejected by the index tree gate.
      if (top && name === 'node_modules' && info.isDirectory() && !info.isSymbolicLink()) continue;
      if (info.isSymbolicLink()) fail('chrono-unsafe-tree');
      const rel = relative(packageRoot, path);
      if (generatedMaps && info.isFile() && rel.startsWith('dist/') && rel.endsWith('.js.map')) { maps.push(path); continue; }
      if (info.isFile() && rel.startsWith('dist/') && rel.endsWith('.js')) javascript.push(path);
      if (info.isDirectory()) entries.push({ name, mode: '40000', hash: visit(path) });
      else if (info.isFile()) {
        files++;
        entries.push({ name, mode: info.mode & 0o111 ? '100755' : '100644', hash: objectHash('blob', readFileSync(path)) });
      } else fail('chrono-unsafe-tree');
    }
    return treeHash(entries);
  }
  try {
    const identity = checkIdentity(visit(packageRoot, true), files, 'chrono-package-tree-mismatch');
    if (!generatedMaps) return identity;
    if (maps.length !== CHRONO_BASELINE.maps || JSON.stringify(maps.sort()) !== JSON.stringify(javascript.map(path => `${path}.map`).sort())) fail('chrono-generated-map-inventory');
    for (const path of maps) {
      const map = JSON.parse(readFileSync(path, 'utf8'));
      const source = resolve(packageRoot, relative(join(packageRoot, 'dist'), path).replace(/\.js\.map$/, '.ts'));
      if (map.version !== 3 || map.file !== basename(path, '.map') || map.sourceRoot !== ''
          || !Array.isArray(map.sources) || map.sources.length !== 1 || resolve(dirname(path), map.sources[0]) !== source) fail('chrono-generated-map-binding');
      if (!lstatSync(source).isFile()) fail('chrono-generated-map-binding');
    }
    return { ...identity, maps };
  }
  catch (error) {
    if (error.code === 'ENOENT') fail('chrono-package-file-missing');
    throw error;
  }
}
export function verifyChronoFiles(packageRoot) { return inspectChronoFiles(packageRoot); }
// Explicit build-only validation. The normal baseline command never allows maps.
export function verifyChronoBuildMaps(packageRoot) { return inspectChronoFiles(packageRoot, true); }

export function verifyChronoIndex(records) {
  const root = new Map();
  let files = 0;
  for (const record of records.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) ([0-9a-f]{40}) 0\t(.+)$/.exec(record);
    if (!match || !match[3].startsWith(CHRONO_BASELINE.package + '/')) fail('chrono-index-invalid');
    const parts = match[3].slice(CHRONO_BASELINE.package.length + 1).split('/');
    if (parts.some(p => !p || p === '.' || p === '..' || p === 'node_modules')) fail('chrono-index-invalid');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
      if (!(node instanceof Map)) fail('chrono-index-invalid');
    }
    const name = parts.at(-1);
    if (node.has(name)) fail('chrono-index-invalid');
    node.set(name, { mode: match[1], hash: match[2] });
    files++;
  }
  const visit = node => treeHash([...node].map(([name, value]) => value instanceof Map
    ? { name, mode: '40000', hash: visit(value) } : { name, ...value }));
  return checkIdentity(visit(root), files, 'chrono-index-tree-mismatch');
}
export function verifyFrozenChrono(repositoryRoot) {
  const git = args => execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let records;
  try { records = git(['ls-files', '--stage', '-z', '--', CHRONO_BASELINE.package]); }
  catch { fail('chrono-baseline-git-unavailable'); }
  // The literal approved tree is self-contained. The provenance commit need not
  // remain reachable after selective integration, branch cleanup, or shallow CI.
  verifyChronoIndex(records);
  const identity = verifyChronoFiles(join(repositoryRoot, CHRONO_BASELINE.package));
  return { status: 'ok', sourceCommit: CHRONO_BASELINE.commit, upstreamPackageTree: CHRONO_BASELINE.upstreamTree, packageVersion: CHRONO_BASELINE.version, integrationDifferences: CHRONO_BASELINE.integrationDifferences, ...identity, index: 'exact', worktree: 'exact', live: { state: 'not-checked' } };
}
export function main(args = process.argv.slice(2)) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let suppliedRoot = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--static-only' || args[i] === '--allow-missing-live') continue;
    if (args[i] === '--repository-root' && !suppliedRoot && args[i + 1] && !args[i + 1].startsWith('-')) { root = resolve(args[++i]); suppliedRoot = true; }
    else fail('chrono-invalid-invocation');
  }
  // This command never discovers or reads live activation. The historical flags
  // remain accepted solely for existing static release-check invocations.
  console.log(JSON.stringify(verifyFrozenChrono(root)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: /^chrono-[a-z-]+$/.test(error.message) ? error.message : 'chrono-verification-failed', live: { state: 'not-checked' } }));
    process.exitCode = 1;
  }
}
