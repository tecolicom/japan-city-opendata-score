// 自治体のディレクトリ municipalities/<pref>/<handle>/ を作る。handle はレジストリを引く (自前で採番しない)。
//   node scripts/new-municipality.mjs --handle hanno [--pref saitama] [--registry <path>]
// --pref は省略できる (code から導く)。指定したときは導出値と食い違えば失敗する。
// web.yaml は指紋採取 (scripts/fingerprint.mjs) が書く。assessments/ は schema が空を許さないので、
// 調べた配信元が 1 件以上できるまでファイルを置かない。
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REGISTRY, loadRecords, prefDirOf, siteUrlOf } from './_lib/municipality.mjs';

const argOf = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const handle = argOf('--handle');
if (!handle) { console.error('usage: new-municipality --handle <handle> [--pref <dir>] [--registry <path>]'); process.exit(2); }
const records = loadRecords(argOf('--registry') ?? DEFAULT_REGISTRY);
const record = records.find((r) => r.handle === handle);
if (!record) { console.error(`handle がレジストリに無い: ${handle}`); process.exit(1); }
const derived = prefDirOf(record, records);
const pref = argOf('--pref') ?? derived;
if (pref !== derived) { console.error(`--pref ${pref} は code ${record.code} から導いた ${derived} と違う`); process.exit(1); }
const dir = join(root, 'municipalities', pref, handle);
mkdirSync(dir, { recursive: true });
console.log(`${dir}\t${record.name_ja}\t${siteUrlOf(record)}`);
