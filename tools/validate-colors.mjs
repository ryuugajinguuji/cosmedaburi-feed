// tools/validate-colors.mjs — colors.json の配信前検証（設計2026-07-11 §1.2）
// 必須: 照合キー②(category,brand,color_code,color_name) の一意性 / 5,000件・500KB 予算 /
//       hex形式 / category・hex_origin(swatch|estimated) 列挙 / 文字列長。違反があれば exit 1。
import { readFileSync, statSync } from 'node:fs';

const COLORS = 'v1/colors/colors.json';
const MANIFEST = 'v1/colors/manifest.json';
const MAX_COUNT = 5000;
const MAX_BYTES = 500 * 1024;
const HEX_RE = /^#[0-9A-F]{6}$/;
// アプリ側 mobile/src/shared/validation.ts の TEXTURES 6分類と一致させること（目視転記・実リテラル優先）
const TEXTURES = new Set(['matte', 'cream', 'satin', 'sheer', 'gloss', 'shimmer']);

const errors = [];
const colorsRaw = readFileSync(COLORS, 'utf8');
if (statSync(COLORS).size > MAX_BYTES) errors.push(`size > ${MAX_BYTES} bytes`);
const body = JSON.parse(colorsRaw);
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
if (!Number.isInteger(body.version) || body.version !== manifest.version)
  errors.push(`version mismatch: colors=${body.version} manifest=${manifest.version}`);
if (!Array.isArray(body.colors)) errors.push('colors is not an array');
else {
  if (body.colors.length > MAX_COUNT) errors.push(`count ${body.colors.length} > ${MAX_COUNT}`);
  if (manifest.count !== body.colors.length) errors.push(`manifest.count ${manifest.count} != ${body.colors.length}`);
  const nameKeys = new Set();
  body.colors.forEach((c, i) => {
    const at = `colors[${i}]`;
    if (typeof c.brand !== 'string' || c.brand.length === 0 || c.brand.length > 64) errors.push(`${at}.brand invalid`);
    if (typeof c.color_name !== 'string' || c.color_name.length === 0 || c.color_name.length > 64) errors.push(`${at}.color_name invalid`);
    if (c.color_code !== null && (typeof c.color_code !== 'string' || c.color_code.length > 32)) errors.push(`${at}.color_code invalid`);
    if (typeof c.hex !== 'string' || !HEX_RE.test(c.hex)) errors.push(`${at}.hex invalid (want #RRGGBB upper)`);
    if (c.category !== 'lip' && c.category !== 'nail') errors.push(`${at}.category invalid`);
    if (c.hex_origin !== 'swatch' && c.hex_origin !== 'estimated') errors.push(`${at}.hex_origin invalid`);
    if (c.texture !== null && !TEXTURES.has(c.texture)) errors.push(`${at}.texture invalid`);
    const nk = JSON.stringify([c.category, c.brand, c.color_code ?? '', c.color_name]);
    if (nameKeys.has(nk)) errors.push(`${at} duplicate key(2): ${nk}`); // 照合キー②一意性（設計§1.2 必須）
    nameKeys.add(nk);
  });
}
if (errors.length > 0) { console.error(errors.join('\n')); process.exit(1); }
console.log(`OK: ${body.colors.length} colors, version ${body.version}`);
