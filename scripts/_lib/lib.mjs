// 共有ヘルパ。YAML 読み込みと、自治体ディレクトリ・レジストリの走査。
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export function loadYaml(path) {
  return parse(readFileSync(path, 'utf8'));
}

const isDir = (p) => statSync(p).isDirectory();

// root/municipalities/<pref>/<handle>/ を列挙する。municipalities/ が無ければ空。
export function listMunicipalityDirs(root) {
  const muniDir = join(root, 'municipalities');
  if (!existsSync(muniDir)) return [];
  const out = [];
  for (const pref of readdirSync(muniDir).filter((p) => isDir(join(muniDir, p))).sort()) {
    const prefDir = join(muniDir, pref);
    for (const handle of readdirSync(prefDir).filter((h) => isDir(join(prefDir, h))).sort()) {
      out.push({ pref, handle, dir: join(prefDir, handle) });
    }
  }
  return out;
}

// municipalities.yaml (配列) を handle 引きの Map にする。
export function loadRegistry(path) {
  const map = new Map();
  for (const r of loadYaml(path)) {
    map.set(r.handle, {
      code: r.code,
      name_ja: r.name_ja,
      type: r.type,
      website: r.website ?? null,
    });
  }
  return map;
}
