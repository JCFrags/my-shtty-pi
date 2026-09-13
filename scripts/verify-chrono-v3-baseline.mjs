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
  "tree": "fdfb0e879e0fdc868a242162feda112120757111",
  "files": 437,
  "maps": 137,
  "package": "packages/pi-chrono-compaction",
  "version": "3.0.2",
  "integrationDifferences": [
    {
      "path": "DEPLOYED.sha256",
      "upstreamSha256": "3954d79d5faa1bb68e189a9db2fc799f0b4659715a2d73c91df2d7e332f3d627",
      "integratedSha256": "78ba974a0d7376953d931c5b17d2889505b873ea91148ff8ab40ea4bdc07d669"
    },
    {
      "path": "README.md",
      "upstreamSha256": "587b68f55d7770db1e226224804aa29d40d136a601d20dbe49c62da989405148",
      "integratedSha256": "5c3df23986c07574d306b672194806ff1fed098d82a341bc81387e3f8d4aa625"
    },
    {
      "path": "dist/src/bounded-memory.js",
      "upstreamSha256": null,
      "integratedSha256": "cf1f549dd22a0885f304c22400824fb82f51b8f41054aa0a8661ab30e04f1cb6"
    },
    {
      "path": "dist/src/catalog-sqlite.js",
      "upstreamSha256": "72ce8cca7d5844c6c8d3d7776b2b869d43fbd2f074e9b99d504b979a59b120a1",
      "integratedSha256": "13ec7279d8f687c1fe8d871ae3540d8648726cd52aa7d6b6283f977655376ca7"
    },
    {
      "path": "dist/src/catalog-worker-client.js",
      "upstreamSha256": "0a1f68da8997cc102d5d43089cc009bb66a1fdd41a121513aa04357f0f52df25",
      "integratedSha256": "9f7344e1a40aea7de306251aea2b6d08612e7e26559f9c4fbd888f3407f39a82"
    },
    {
      "path": "dist/src/causal-memory.js",
      "upstreamSha256": "5c2262b6b5400d783b75391ce246d672819e6c37cadad726968b7cf0719d0325",
      "integratedSha256": "7033b2a50f225e59fdc738a10dad4d98169375beee5c1ff8778f471baa6bde0f"
    },
    {
      "path": "dist/src/compaction-worker-client.js",
      "upstreamSha256": "69e8b9ff7473eb4967c92e98391a9ad2e776b03f3b96e8e2147f8017e8b3e889",
      "integratedSha256": "c1a8d40a35188c19cea77b3cf29764b6133b54c459142ba5afd7cf45b769f6cd"
    },
    {
      "path": "dist/src/compaction-worker-protocol.js",
      "upstreamSha256": "1d9384a53dccca9411ac412cc97b76159850a94868301fa4d9551b5bc27411f6",
      "integratedSha256": "879d35ce508e8b03e7d7ce016a26691906bd614af168252eb9fc173f36547435"
    },
    {
      "path": "dist/src/compactor.js",
      "upstreamSha256": "ab4d760064fe7588a02458e3fda4e72541499dac9741361515d0fdf5114aa5d0",
      "integratedSha256": "2b6d37a71dd73fa52084d70c76c5a689545208e8e4434d314761157ace39aa1f"
    },
    {
      "path": "dist/src/composition-preview.js",
      "upstreamSha256": "e41d4aab5c6164cb123e55a0c12b0e5db2ba1f408ffab8c0d7b5382d887c09fc",
      "integratedSha256": "bc4497d5e2d9fc4f0238c7aaa4aeb3545f0ea39e09454412e464f99e880c251e"
    },
    {
      "path": "dist/src/context-budget.js",
      "upstreamSha256": null,
      "integratedSha256": "b39a4ba88c3053449b998cb0965d9e20fd7d3c9608bb12d2177bdc47de841bee"
    },
    {
      "path": "dist/src/context-composer.js",
      "upstreamSha256": "a8f229ffab1214785dee39ecccb86b661474d9490aca9bb36eb2b4cc1027cdfa",
      "integratedSha256": "027571d022a747ccf49252355d3d9f866129b7839dab9ce0aaebb659aa11cb17"
    },
    {
      "path": "dist/src/episode-rollup-store.js",
      "upstreamSha256": "b3829c50714e79d5ae308f5007e95b5f0ef66bb837682f686d3e252b847fb4ad",
      "integratedSha256": "8b702487355a7b214cba31e171fb891891b6db9c6a5c59ca1efe1518f7451540"
    },
    {
      "path": "dist/src/episode-state-contract.js",
      "upstreamSha256": "2de30bcfeeaf1be90d335dfc5243ff7d284200a9398920004e08dcbcfa73fb85",
      "integratedSha256": "028269eb33e21c9bcc71a6c77b62bb643d65bea1e74799cf481527b72d295ead"
    },
    {
      "path": "dist/src/episode-state-reducer.js",
      "upstreamSha256": "5075e2b0cd3c4c046415ffc320185ab70e4be66d7650e443a3a696051d84f69d",
      "integratedSha256": "e54d2f4937311e4dfcf28c950b5a369c8387b0fba29976e5df0a6bbde97e02f8"
    },
    {
      "path": "dist/src/episode-state-store.js",
      "upstreamSha256": "4feba6d1cd5d0c7e51cfb9dc696bd5eef807339a36fb5da8ae720e93b7a9562b",
      "integratedSha256": "5477564f94a6dd230114d31b4f298b1ef4a26b48b84d68da49c35aa3656ea895"
    },
    {
      "path": "dist/src/history-search-adapter.js",
      "upstreamSha256": "4de4670ea409416c241ac73422700d819dd700bb33d2543c484d1300ba559ade",
      "integratedSha256": "b55b03d8159a2cf8041c884059ccc59b02f7aad41a9d21133bf70114d05ae756"
    },
    {
      "path": "dist/src/host-worker-scheduler.js",
      "upstreamSha256": "e2ac0b1fa37bd377e07e46d9c735a87f31e9ec5bb29e54a0903bf89668bdb8b9",
      "integratedSha256": "0b44db2211aa65c1c311b5a49d8dd07ff075c3bf8cc98fd1f961bea2f01e2c26"
    },
    {
      "path": "dist/src/logical-session-checkpoints.js",
      "upstreamSha256": null,
      "integratedSha256": "0ba7c017b6d225f54f85c9de6b15140aa03a380ec4374bf824e1907f4492430b"
    },
    {
      "path": "dist/src/logical-session-contract.js",
      "upstreamSha256": "4f8151e2e739942e28e8e50828f9f8426b2a756dcbc24a04306032bf13f02fde",
      "integratedSha256": "ad05b281739d73810d4b7a8c8f355afa93adba5cf293889abda5cc941323bef4"
    },
    {
      "path": "dist/src/logical-session-integration.js",
      "upstreamSha256": "b92ed77386c2233c3ea2247f2b70cf247b7e0398c4aa8e38de95af6f0b0fada5",
      "integratedSha256": "4c237527381e2c717033ea2a76d83ded7b52778e4d2c8bccd8343c24d4e3de27"
    },
    {
      "path": "dist/src/logical-session-persistence.js",
      "upstreamSha256": null,
      "integratedSha256": "7edfead92ab5ee1649cbab502113f231a45443c74484ae782ed2a11ab21962c9"
    },
    {
      "path": "dist/src/logical-session-rollover.js",
      "upstreamSha256": "6d4d4527778ed8a974094c8ff29a000802eee85fb7e1e125901f501cc43d0954",
      "integratedSha256": "7423ab7cdfd3c0bd6b9ad6bdd1c97230887d5652eb3095d1fa1769f33b1a366d"
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
      "integratedSha256": "1cf63c2477fefedaac4fa1dd39506c8d201e59a493b7109d237963076c7f70cd"
    },
    {
      "path": "dist/src/pi-extension.js",
      "upstreamSha256": "fd73ff49e06a2e3da1899b62bed11a2e90aac0a98f6b4b6dba4d6f7af728ac7c",
      "integratedSha256": "0cbeae994f85f621bfef59796c18feaadefcc7b75e6450b61b108dab80de3bb2"
    },
    {
      "path": "dist/src/pi-hybrid.js",
      "upstreamSha256": "c7519227a72801f70f019966ebaa1bbb37c2b2d26ec94a3e7bfadaccf2b64bd4",
      "integratedSha256": "c4eb3985d058df229deea7c229e192be34382e2dd465d5eaa2850961df767226"
    },
    {
      "path": "dist/src/plain-renderer.js",
      "upstreamSha256": "03bca765b4bb0b238b08313f582d7c4d70b0ce2204bfc7eb5785db7311939932",
      "integratedSha256": "df6c7753b9de09d191a3fa4df7c0a18083926f0b33b8073194940e322aeb59ae"
    },
    {
      "path": "dist/src/runtime-identity.js",
      "upstreamSha256": null,
      "integratedSha256": "91a90554d5f55a5aa2c71c638baa23f5282700fc6447024607224d8ab26b5dbd"
    },
    {
      "path": "dist/src/search-v3-store.js",
      "upstreamSha256": "48be2400c11556abbf54e9638db56f2e0877ed5ce9918425471f5e7fcb6572cb",
      "integratedSha256": "1cf755a201f5d48aa69821b3626c415f4191f9cc275d0a147f6ec3d8abe81a9e"
    },
    {
      "path": "dist/src/search-v3-worker-client.js",
      "upstreamSha256": "6da6628c4f6c477766d1ab87046f986bce74dc0717a2d48ebbfc55955f8292ed",
      "integratedSha256": "475a26a41e2b0ea0417ce9000e8d3ab894fd827fa3242ff4dcc16ff56399c60c"
    },
    {
      "path": "dist/src/session-migration.js",
      "upstreamSha256": null,
      "integratedSha256": "ddc1138c3a046c05d999a24da1600d3ea2f85538f3720b3bb7d594dd57eff9e9"
    },
    {
      "path": "dist/src/user-config.js",
      "upstreamSha256": "fc4e3a512a147192328f57aada22219469c16ec65c27b9ee019d1a57aa6f03c0",
      "integratedSha256": "8750ab7f0d5ae7377bcad3ef912043a36c30299b57e89a341a52ced711554451"
    },
    {
      "path": "dist/src/worker-runtime-status.js",
      "upstreamSha256": "da3867499b3fc41d30c9bb7f46b2986bbecc19cf94e6a81d7e7ca7e810234cf2",
      "integratedSha256": "a3059779dbc4b16a0821d51bbb3d29dbd06bac8ea31fa1309696f4f01f9ca2de"
    },
    {
      "path": "package-lock.json",
      "upstreamSha256": "42024d0876d7a367509bb86b11601c3ede4cebb7282cfb14b803d42ce60114d9",
      "integratedSha256": "0debd5bed2387b73cb51ff364fd31b9b96fdc5646f3a27f43dbff65e8cd532af"
    },
    {
      "path": "package.json",
      "upstreamSha256": "18e98ac6afc84a504df0c3bee20690941c2a60390f74b0d413603b0b2cf717e4",
      "integratedSha256": "641858cf94140883c25c0ee1e7582362f3b9a96e350c6f03ea33df49b73c4868"
    },
    {
      "path": "scripts/m11-logical-pi-qualification.mjs",
      "upstreamSha256": null,
      "integratedSha256": "168bd96cc1ac65c253f7e8e20c92a714a283a53a43960ea4d4da95241f29aa23"
    },
    {
      "path": "scripts/m11-retained-tail-recovery.mjs",
      "upstreamSha256": null,
      "integratedSha256": "cb18cca9c15b2f17a224ea78c437eacc8beea0e54742440c0f4622e7bf83239c"
    },
    {
      "path": "scripts/m11-scale-campaign.mjs",
      "upstreamSha256": null,
      "integratedSha256": "fc87ce26cb4df7a9cfcca12ad845342b6c05e3a3ea90d0abc781d8fa210ed766"
    },
    {
      "path": "scripts/m11-supplemental-faults.mjs",
      "upstreamSha256": null,
      "integratedSha256": "67ec9fb38180b3ba9f080c11f56858639173a215725971a1086cca14150c118d"
    },
    {
      "path": "scripts/v3-core-pi-check.mjs",
      "upstreamSha256": null,
      "integratedSha256": "9bacbf121d5a3f0765382cc48c9cae72e0b08f3a446ec0ca09803df81bc98607"
    },
    {
      "path": "src/bounded-memory.ts",
      "upstreamSha256": null,
      "integratedSha256": "2aec74f9a9d400c897f200ecc998a0ec63f2c228e96e1e408f628d12e208fc00"
    },
    {
      "path": "src/catalog-sqlite.ts",
      "upstreamSha256": "d0e00f72cfcc8cbc688babf3cec4e17b6ec0e47e02ca11f5a4c1c26355dc4392",
      "integratedSha256": "655031ecc61e4ac30e26db558b9736327ddaa6e319010d2d8d108060b044b189"
    },
    {
      "path": "src/catalog-worker-client.ts",
      "upstreamSha256": "2bf683f1bcb4540f70143beb66e71ee7775a58f619489635f0ded82fd9f39227",
      "integratedSha256": "b764125abc082446197dabc0c7ec8c94c32be49468d3cffc10b4e241989c8cb9"
    },
    {
      "path": "src/causal-memory.ts",
      "upstreamSha256": "b2e5fba8a7f31df56dd68348cb9a948fa679f851fe0c0649bb14ab47b2dc7e38",
      "integratedSha256": "2f1601a3bc0900224b7b11c07fb2220ceff1e9429394f67b7dea950640bae1b0"
    },
    {
      "path": "src/compaction-worker-client.ts",
      "upstreamSha256": "4ac2317703fa6b903bbcb964faccc28e35970bde4e53203711967b177be0daca",
      "integratedSha256": "98047a87fb4d8e5b6774c81d2120a7bd963c4baddbd1a6949ea759905fa42463"
    },
    {
      "path": "src/compaction-worker-protocol.ts",
      "upstreamSha256": "81e51ca4637e194fe0c6863600dd2d9a94268c164909e2e4045a9daaf945ed4a",
      "integratedSha256": "8f0429f4235710ee5ddcec2b9730cf432b4cbfc38138691573c00a77f23485d4"
    },
    {
      "path": "src/compactor.ts",
      "upstreamSha256": "309a0ddf3d6e807a349689068d2884617f4508b544341f6552c8a5d45a5b36ec",
      "integratedSha256": "3208ec66cd59919aac8058b3ba7e1110b643a2d6667522b1d20130f620b457e1"
    },
    {
      "path": "src/composition-preview.ts",
      "upstreamSha256": "889c62bb2f028544cdaef24062fead1d641a0d7da43bd90d23999e00a5ca31a3",
      "integratedSha256": "1ea4fe9eea8a5fee524b8ce16fc1d5b65b5836158278179f97d3935e2a5faf4e"
    },
    {
      "path": "src/context-budget.ts",
      "upstreamSha256": null,
      "integratedSha256": "7609284b8395d7395e00ae44dc19341a9e080e42a00cc10e8bb741abd3083da9"
    },
    {
      "path": "src/context-composer.ts",
      "upstreamSha256": "de8542d97a3bd980208e1aa241961204e2feedf66b2a1bacffc71af0a3424258",
      "integratedSha256": "cdab5f1a5d19f19c3743cf875466502eaec7e26adad99883ff292ccfbf751741"
    },
    {
      "path": "src/episode-rollup-store.ts",
      "upstreamSha256": "c751b0d9a9ad0a36e5562c7fa1b100f4e72bc83aa3cdb074e1b9afe5b2d7ea2e",
      "integratedSha256": "146aa5db5b5e685324730f3ef443491ac22001aa99b819374159dc008af08f01"
    },
    {
      "path": "src/episode-state-contract.ts",
      "upstreamSha256": "837cd29803d0b452f503284e14f53db1547e78dbf10d1366eacdf45e3a510e47",
      "integratedSha256": "6b9008a29dcc3400e649e0982d43091cf0679041ff355a3476a11f5802929709"
    },
    {
      "path": "src/episode-state-reducer.ts",
      "upstreamSha256": "64d5cc88e7045a04cefae23f31ec1f8e6fb577763e206067bb6fc490d262b794",
      "integratedSha256": "3ed6e6679307bd660c105ef9ec042758c38282f84db74a59eb89e6f19caf9fbe"
    },
    {
      "path": "src/episode-state-store.ts",
      "upstreamSha256": "3ba48f5e633617b6d2d3668b507408d8baec7f586338be23dc2b216c459e1dac",
      "integratedSha256": "aaee653c7830e163c06e7132fda5b59e0d21b6e2753786491a19bcb91cb51662"
    },
    {
      "path": "src/history-search-adapter.ts",
      "upstreamSha256": "e7fcc2a307258288650f219bb57ced340cb55fadc3a7a3ab00ae9e408ca8419a",
      "integratedSha256": "fd5011a6402bdbbf85e2a7dc647b9b3e88266ad83b149713bc3553b5dd5044b6"
    },
    {
      "path": "src/host-worker-scheduler.ts",
      "upstreamSha256": "1965b64549d746e64b4a02bc82bea24a7cb84ff6afa5bc38ec95005574eea32d",
      "integratedSha256": "d4cf99a22b8d2a4481e2bf37878f731b5975f636fc7397989ef8749d97a41b48"
    },
    {
      "path": "src/logical-session-checkpoints.ts",
      "upstreamSha256": null,
      "integratedSha256": "715db27fa3b10c2f7ad4e20690e5fcbdc2830eea43a9626c9feecabd10706ed1"
    },
    {
      "path": "src/logical-session-contract.ts",
      "upstreamSha256": "5b83cd65c1c57e313fac543619d55f29f5ef009fa8e32a296ae01bf9d4834380",
      "integratedSha256": "8056c5e8f08d06fe445717fabc3df3dad90a5fd0582043bb01e63253ddf8c46b"
    },
    {
      "path": "src/logical-session-integration.ts",
      "upstreamSha256": "a9ee8074c4522ce5382ee8496b5799895f009d9de3eb2311bb2d5540b60aa776",
      "integratedSha256": "24c57c38877041c2165bbcb64b08d033107cd198496edd6a1d910817ab1bbe44"
    },
    {
      "path": "src/logical-session-persistence.ts",
      "upstreamSha256": null,
      "integratedSha256": "c601dd2c307dc58d4df59c1f72e8190a1b4ccef3a9ecdd2e51eaa9175da69e0f"
    },
    {
      "path": "src/logical-session-rollover.ts",
      "upstreamSha256": "94f8bd713c5cb40f44255f7497c7ab757fd920f740e09960caf5940cfedaf8a1",
      "integratedSha256": "ebf1733bb32d094b04296dffc248d3856e382570d4fbb8cd0d9bbff2e6d86fe2"
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
      "integratedSha256": "d87cc5a828de406689e6534c9329e61a2576ce3f32e7ba003ebc62300b294b26"
    },
    {
      "path": "src/pi-extension.ts",
      "upstreamSha256": "5887ef236ee27480921f72e6b2fddb3987d2702492fc3a771d0c7f2056a3c48b",
      "integratedSha256": "4b57b900c40740e67f1f6b2d12f0130b5d8c651987b193ed4fbc433d5c361c9e"
    },
    {
      "path": "src/pi-hybrid.ts",
      "upstreamSha256": "edac4b3ea03b21a348af45b6495debbc8f817f85ed5bef23502fcb42c37bc1f1",
      "integratedSha256": "7c6a933762b0116f61e2f7243e4002fba20ddfff8d9cee2427f0391ef078eead"
    },
    {
      "path": "src/plain-renderer.ts",
      "upstreamSha256": "d1791e717774bc3ae2327f2486fbdc93a286e481827ecb46fe3c11c8da9ce8d1",
      "integratedSha256": "cb95e6f4385db544faae02c2725a667f9462838d42b474af4f31afb11efd00a3"
    },
    {
      "path": "src/runtime-identity.ts",
      "upstreamSha256": null,
      "integratedSha256": "d73b21220f11dc645ebf767b70d1b838842d585412c959e6e87f973438cea792"
    },
    {
      "path": "src/search-v3-store.ts",
      "upstreamSha256": "3b35817d451dbfa9dbd757da7427e570b3bc8d4125bdd859752af17c298b8769",
      "integratedSha256": "d8d0cfe148f6415eee0b49e5218671d3d1bf856f24e715253241479fb602f4f9"
    },
    {
      "path": "src/search-v3-worker-client.ts",
      "upstreamSha256": "86abbdcaa4c54d91095c13b15f7594a796d15c4782b4506f7bbc343e92db4257",
      "integratedSha256": "831fdc3d1806f4fc1656b4a94f5ea322a636e6a884ae0231b308674305903244"
    },
    {
      "path": "src/session-migration.ts",
      "upstreamSha256": null,
      "integratedSha256": "b6bd6f6bbaf334b0c42d92dc5769a0ea3d5566f8451c8747ca9645e189489463"
    },
    {
      "path": "src/user-config.ts",
      "upstreamSha256": "76f4923bcfdb097284eca1e55a0c41227feaf14eed28ff5f696d478671099f63",
      "integratedSha256": "e5cd1f2ae545b8234eaf164424467d9dfbc6d67c4fc472eb76dbf8cc4ac2f0bc"
    },
    {
      "path": "src/worker-runtime-status.ts",
      "upstreamSha256": "476a2b846bab49ea5fb1ee67bb1daf4cb6c993a88a651d10a4b96b0ec14a56cf",
      "integratedSha256": "27695f73ec5f8bee4058d99e6a82a23374c3c7779032123043d680f59c8630d5"
    },
    {
      "path": "test/capsule-extension.test.ts",
      "upstreamSha256": "6070fcea5f49f22632d37d2853b6538b3c3daf41ff28608de002dda6b31d9902",
      "integratedSha256": "c53839ed7cb17c08925bf14f3220bdf44ecd2cdf4febfccf14234d48346b6f17"
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
      "path": "test/catalog-sqlite.test.ts",
      "upstreamSha256": "3b1d85de0719a7b8d9d023148c79a7b5cc40cb846ba5c684f196727c390853f0",
      "integratedSha256": "8d1905a320e33f060bcc8817e34460862b761fc699c46b15b5394748f9a5245f"
    },
    {
      "path": "test/compaction-worker.test.ts",
      "upstreamSha256": "9bad8c73b45154d69bdb14ce9c31e92c63bf501c1537f2576f20552329b307f2",
      "integratedSha256": "d1ccd032160b4cd04738c3538eed716b7b93fe55c780ea6638c9db0e5e63e625"
    },
    {
      "path": "test/composition-preview.test.ts",
      "upstreamSha256": "893e81e71a0408f8844b7bb48b15293ec2cb06adf85782e108b6629718b620ca",
      "integratedSha256": "ea4ce7d45710bdff9094070a3172f3b266106cee862c1915faf4dfd4eb85ebf1"
    },
    {
      "path": "test/context-composer.test.ts",
      "upstreamSha256": "a80185196d6617fcddaaedc457b8babf3b0a8e941c891acff51700944af59ff2",
      "integratedSha256": "8b9e1665fd585e6f5f3d6303304bf1ab0d0cf4f5851934a8484968643a59bfe5"
    },
    {
      "path": "test/episode-state-supersession.test.ts",
      "upstreamSha256": null,
      "integratedSha256": "080b58782a9e46fc6d897f15d7fc7066ae71c045a794fb3b9d309328126bc9ea"
    },
    {
      "path": "test/episode-state.test.ts",
      "upstreamSha256": "e26e4c3866c0fb6988168ac53d0d14e7637d6ef5a5519e3aaf1e08eb2e31bb24",
      "integratedSha256": "26650861136feb33e9e663e333f9b5580d0d0249647431929a07aef33eb8f5ef"
    },
    {
      "path": "test/extension.test.ts",
      "upstreamSha256": "1d0247207b0dc2fc30e3b219c277d0f8ad4ffdf12e7be9d7f5ac11f782675c06",
      "integratedSha256": "d4cb4794dd493ca23f7957868202468668f04c5791ce336b1b29ecdcfdc04e58"
    },
    {
      "path": "test/history-search-adapter.test.ts",
      "upstreamSha256": "c025d07d72fd03778e3fe1b823a3d7519a977fac8d82670da1e6f51c95faf0f3",
      "integratedSha256": "c8b2f9e08dcbdc165d1a5f4c7c1f79690dd19be44745a809f13e0d2ee6171614"
    },
    {
      "path": "test/history-worker-isolation.test.ts",
      "upstreamSha256": "8bd29c912e3f9a8ef96c99a3490218b561770bbaac7f03a712362e36c2dcf217",
      "integratedSha256": "8e6ffd4ef884cc2db3cc66ba1062d78325e505ba707e9d2387742d9d51fbf112"
    },
    {
      "path": "test/history-worker-promotion-receipts.test.ts",
      "upstreamSha256": "1b46b286ef2f935666777e6dcd3319d35046d80f2297be60b5e820f4cb605299",
      "integratedSha256": "10c7a7a4fa35a0a7f5f13882ab5e06fdbb9a87c18a4b6fd65846eeec61f36b0b"
    },
    {
      "path": "test/history-worker-recovery.test.ts",
      "upstreamSha256": "b538fc25319c0117a7801ed66f110248749d4984dc9fda67bb9c04b6358a0618",
      "integratedSha256": "b6913ad0bdbe1cd2aa5d53dc6de5a9031439da54a3589f970eaacda4f7610c24"
    },
    {
      "path": "test/hybrid.test.ts",
      "upstreamSha256": "9358391e87da213dab2bf988c27ca55eccf57cc2827670ee659b9ab73d2132fe",
      "integratedSha256": "5980d81f57494622914ee1229f0326dd14533c18543bedbdc835dbe3591ce8e7"
    },
    {
      "path": "test/independent-review-characterization.test.ts",
      "upstreamSha256": "c80d97110b6186f2d501762fd8a2eb458c7fa3f5fe95c31955ef8460cad8e3dd",
      "integratedSha256": "907e27c25dec87fe10293a8fb145e61f665f662ba29a9a2186c69658700bc72c"
    },
    {
      "path": "test/legacy-memory-safety.test.ts",
      "upstreamSha256": "04d0f45c0e428a3f28635cc6eb4b03d84717fea161575c317511dad3d350f29b",
      "integratedSha256": "ec43ea0bd32c8df9ee9cb4c3beca986fb5de0940e595d93c72bdc1140d548b97"
    },
    {
      "path": "test/logical-session-rollover.test.ts",
      "upstreamSha256": "cc8ed24310a5ff9301a48ffda61fadb3301b59b560e4b194073bfb7a364d1fd8",
      "integratedSha256": "7e1bf9f472e474b88c8227d94762a2787fd7d801b179ac11985187657e404ea6"
    },
    {
      "path": "test/m11-scale-campaign.test.ts",
      "upstreamSha256": null,
      "integratedSha256": "f4baae57b34011657016dd9d90dc7cd7a3403965a191d09081768aee4b5c0035"
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
      "integratedSha256": "f9a35882bb8107ae3238c8f29a2429bc7344cf97eaf233d70effcbb8916cbf60"
    },
    {
      "path": "test/session-migration.test.ts",
      "upstreamSha256": null,
      "integratedSha256": "b29977cd2f643a17a71cc82e770d1bd3b25085d924d8b568a7691a62d178efc7"
    },
    {
      "path": "test/synthetic-history-adapter.ts",
      "upstreamSha256": "6e90caac0b8fb81fadaecb3022d2f259f00405a9a4e2dc006fbba5c6aa18ee46",
      "integratedSha256": "d8ec7ccec7a68f24da9d9b2c1d581f9e0bd0eab07272315d191646c739022aa1"
    },
    {
      "path": "test/v11-retention-gradient.test.ts",
      "upstreamSha256": "5bd633bef9ead93cde06046828d1a0211284fe1644c60481bca152162cf5ebb1",
      "integratedSha256": "24a0910f69b045db3346947e9edf130bec02ab07a60832028ed8cd9b3b2fe0fb"
    },
    {
      "path": "test/v2-extension-integration.test.ts",
      "upstreamSha256": "c36e5ee9d4a74ef4a2561a0bc6aa3aaae7c04c03671b8461df33fd1f9e0bce7a",
      "integratedSha256": "9fa06d595b9cdd6004cc9d7f8ded37d4a0ff0c6939a9099c46ec4b825500fe43"
    },
    {
      "path": "test/v2-render-recovery.test.ts",
      "upstreamSha256": "6076ad0741d81ade4ae797a0736b290fcde40fd30fd81e6ff6cde4e2a29bfcd9",
      "integratedSha256": "4ad4810783f5cdbb52ac62d502817fa0a04ac4eff155fb620e1a4d296833d332"
    },
    {
      "path": "test/worker-runtime-status.test.ts",
      "upstreamSha256": null,
      "integratedSha256": "4c2e752605054acb443be0b38e17eb1fe780379c87127e45d11d4d1349bb2493"
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
