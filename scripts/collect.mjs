/**
 * collect.mjs — 自動収集スクリプト（spec23 §2 Phase B）
 *
 * - 依存ゼロ（Node 20標準のみ）
 * - fetch注入によりテスト時はモック差し替え可能
 * - note は常に '' — 非空は即exit 1（CI fail）
 *
 * 使用方法: node scripts/collect.mjs
 * テスト:   node --test scripts/collect.test.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { KNOWN_BRANDS } from "./brands.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ---- YAML 最小パーサー（依存ゼロ） ----

/**
 * 超軽量YAMLパーサー（sources.yml / color_dict.yml の形式に限定対応）
 * - "key: value" / "- item" / "  - item" / ブロックのみ
 * - コメント(#)・空行は無視
 */
export function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  return parseYamlLines(lines, 0, 0).value;
}

function parseYamlLines(lines, startIndex, baseIndent) {
  const result = [];
  let i = startIndex;

  while (i < lines.length) {
    const rawLine = lines[i];
    const stripped = rawLine.replace(/#.*$/, "").trimEnd();
    if (!stripped.trim()) { i++; continue; }

    const indent = stripped.length - stripped.trimStart().length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; }

    const line = stripped.trim();

    if (line.startsWith("- ")) {
      // シーケンスアイテム
      const content = line.slice(2).trim();
      if (content.includes(":")) {
        // マッピングを含むアイテム
        const obj = {};
        const kv = parseKeyValue(content);
        if (kv) obj[kv.key] = kv.value;

        // 次の行でネストされたキーを探す
        i++;
        while (i < lines.length) {
          const nextRaw = lines[i];
          const nextStripped = nextRaw.replace(/#.*$/, "").trimEnd();
          if (!nextStripped.trim()) { i++; continue; }
          const nextIndent = nextStripped.length - nextStripped.trimStart().length;
          if (nextIndent <= indent) break;

          const nextLine = nextStripped.trim();
          if (nextLine.startsWith("- ")) {
            // このオブジェクト配下のシーケンス — 通常のパースに戻す
            break;
          }
          const nextKv = parseKeyValue(nextLine);
          if (nextKv) {
            if (nextKv.value === null) {
              // ネストブロック
              const sub = parseYamlLines(lines, i + 1, nextIndent + 2);
              obj[nextKv.key] = sub.value;
              i = sub.nextIndex;
            } else {
              obj[nextKv.key] = nextKv.value;
              i++;
            }
          } else {
            i++;
          }
        }
        result.push(obj);
      } else {
        result.push(content.replace(/^["']|["']$/g, ""));
        i++;
      }
    } else {
      const kv = parseKeyValue(line);
      if (kv) {
        // 辞書ブロック — buildDict が自分のインデント範囲だけ消費し、
        // 消費し終えた位置(nextIndex)をそのまま返す（末尾まで飲み込まない）
        return buildDict(lines, startIndex, baseIndent);
      } else {
        i++;
      }
    }
  }
  return { value: result, nextIndex: i };
}

function parseKeyValue(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const key = line.slice(0, colonIdx).trim().replace(/^["']|["']$/g, "");
  const rawVal = line.slice(colonIdx + 1).trim();
  if (!rawVal) return { key, value: null };
  const value = rawVal.replace(/^["']|["']$/g, "");
  return { key, value };
}

function buildDict(lines, startIndex, baseIndent) {
  const dict = {};
  let i = startIndex;
  while (i < lines.length) {
    const rawLine = lines[i];
    const stripped = rawLine.replace(/#.*$/, "").trimEnd();
    if (!stripped.trim()) { i++; continue; }
    const indent = stripped.length - stripped.trimStart().length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; }
    const line = stripped.trim();
    if (line.startsWith("- ")) { i++; continue; }
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) { i++; continue; }
    const key = line.slice(0, colonIdx).trim().replace(/^["']|["']$/g, "");
    const rawVal = line.slice(colonIdx + 1).trim();
    if (!rawVal) {
      // ネストブロック（配列）
      const sub = parseYamlLines(lines, i + 1, baseIndent + 2);
      dict[key] = sub.value;
      i = sub.nextIndex;
    } else {
      dict[key] = rawVal.replace(/^["']|["']$/g, "");
      i++;
    }
  }
  return { value: dict, nextIndex: i };
}

// ---- RSS パーサー（正規表現・DOMParser不使用） ----

/**
 * RSS/RDF XML テキストから item[] を抽出
 * @returns {{ title: string, link: string, pubDate: string }[]}
 */
export function parseRss(xml) {
  const items = [];
  // <item>...</item> または <item ... /> ブロックを抽出
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link") || extractTag(block, "url");
    const pubDate = extractTag(block, "pubDate") || extractTag(block, "dc:date") || "";
    if (title && link) {
      items.push({ title, link, pubDate });
    }
  }
  return items;
}

function extractTag(text, tag) {
  // CDATA と通常テキスト両対応
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))`,
    "i"
  );
  const m = text.match(re);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? "").trim();
  return decodeHtmlEntities(raw) || null;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ---- 日付パース ----

/**
 * pubDate → YYYY-MM-DD（UTC基準、パース失敗は今日）
 */
export function parsePubDate(pubDate) {
  if (!pubDate) return todayStr();
  // ISO 8601 / RFC 2822 どちらも Date が処理できる
  const d = new Date(pubDate);
  if (isNaN(d.getTime())) return todayStr();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayStr() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---- ブランド・slug 抽出 ----

// 日本コスメ頻出ブランド名は scripts/brands.mjs に分離（spec27 §1.3）

function isKatakanaChar(ch) {
  return ch >= "゠" && ch <= "ヿ";
}

function isAsciiWordChar(ch) {
  return /[A-Za-z0-9&]/.test(ch);
}

/**
 * タイトル中のブランド出現が「単語として独立」しているか（境界チェック）。
 * カタカナブランドは前後がカタカナだと別語の一部（例:「クエスト」⊃「エスト」誤判定
 * =実機確認 2026-07-02）。ASCIIブランドは前後が英数字だと別語の一部（例: SKATE⊃KATE）。
 */
export function brandOccursAsWord(title, brand) {
  const brandIsKatakana = /^[゠-ヿ]+$/.test(brand);
  const brandIsAscii = /^[\x21-\x7E\s]+$/.test(brand);
  let idx = title.indexOf(brand);
  while (idx !== -1) {
    const before = idx > 0 ? title[idx - 1] : "";
    const after = idx + brand.length < title.length ? title[idx + brand.length] : "";
    let ok = true;
    if (brandIsKatakana) {
      if ((before && isKatakanaChar(before)) || (after && isKatakanaChar(after))) ok = false;
    } else if (brandIsAscii) {
      if ((before && isAsciiWordChar(before)) || (after && isAsciiWordChar(after))) ok = false;
    }
    if (ok) return true;
    idx = title.indexOf(brand, idx + 1);
  }
  return false;
}

// 小書き仮名・長音符（前の文字と同じモーラ/語幹を継続する記号）。
// この直後にキーワードが終わる場合は「そこで語が切れていない」＝別語の可能性が高い
// （例:「ファンデ」+「ィ」＝ファンディ選手／「ファンデ」+「ー」＝ファンデータ）。
// 一方で通常サイズの仮名が続く場合は複合語の可能性が高く許容する
// （例:「アイシャドウ」+「パ」＝アイシャドウパレット）。
const SMALL_KANA_OR_CHOONPU = new Set([..."ァィゥェォヵヶッャュョヮー"]);

/**
 * category_rules のキーワードがタイトル中で「単語として独立」しているか
 * （brandOccursAsWord と同型・spec32続報 2026-07-09）。
 * - カタカナ語: 前方は brandOccursAsWord と同じ厳格判定（直前がカタカナなら除外＝
 *   例「フィリップス」⊅「リップ」「タイムスリップ」⊅「リップ」）。後方は小書き仮名・
 *   長音符が続く場合のみ除外し、通常サイズの仮名が続く複合語は許容する。
 *   sources.yml の category_rules は「ファンデーション」等の拡張形も別キーワードとして
 *   個別収録済みのため、短縮語（「ファンデ」等）側の後方境界を厳格化しても
 *   正当な複合語（「ファンデーション」）の取りこぼしは起きない
 *   （「ファンデーション」キーワード自体が独立にマッチするため）。
 * - 英数語: brandOccursAsWord と同じ（前後どちらも英数字なら除外）。
 * - 漢字・ひらがな・混在語: 従来通り境界チェックなし（部分一致のまま）。
 */
export function categoryKeywordOccursAsWord(title, keyword) {
  const isKatakana = /^[゠-ヿ]+$/.test(keyword);
  const isAscii = /^[\x21-\x7E\s]+$/.test(keyword);
  let idx = title.indexOf(keyword);
  while (idx !== -1) {
    const before = idx > 0 ? title[idx - 1] : "";
    const after = idx + keyword.length < title.length ? title[idx + keyword.length] : "";
    let ok = true;
    if (isKatakana) {
      if (before && isKatakanaChar(before)) ok = false;
      if (after && SMALL_KANA_OR_CHOONPU.has(after)) ok = false;
    } else if (isAscii) {
      if ((before && isAsciiWordChar(before)) || (after && isAsciiWordChar(after))) ok = false;
    }
    if (ok) return true;
    idx = title.indexOf(keyword, idx + 1);
  }
  return false;
}

/**
 * タイトルからブランド名を機械的に抽出（既知ブランド優先・境界チェック付き）
 */
export function extractBrand(title) {
  for (const brand of KNOWN_BRANDS) {
    if (brandOccursAsWord(title, brand)) return brand;
  }
  // 「ブランド名」 の形式を探す
  const m = title.match(/^([^\s　「」【】（）\[\]]{2,20}?)[　\s]/);
  if (m) return m[1];
  return "unknown";
}

/**
 * ブランドが既知辞書ヒットか（先頭語フォールバック抽出はタイトル断片の
 * 誤抽出が多く表示品質に耐えない＝実機確認 2026-07-02）
 */
export function isKnownBrand(brand) {
  return KNOWN_BRANDS.includes(brand);
}

// ---- 表示品質バー（spec23 §2 実機スモーク 2026-07-02 で導入） ----

/** 色ダブりに直結するカテゴリのみ表示（skincare/info は色比較対象外） */
export const COLOR_CATEGORIES = ["lip", "eye", "cheek", "base"];

/**
 * フィードに載せる表示品質バー。
 * - 手動キュレーション済み（color_name あり）は常に通す
 * - 自動収集分は「既知ブランド辞書ヒット AND 色カテゴリ」のみ通す
 *   （brand=unknown の作業手袋・映画PR等が新色語だけで混入した実害への対策）
 * 収集時の新規追加と、既存フィードの毎回プルーン（自己修復）の両方で使う。
 * @param {{ brand?: string, category?: string, color_name?: string }} item
 */
export function isDisplayQuality(item) {
  if (typeof item.color_name === "string" && item.color_name.length > 0) return true;
  return isKnownBrand(item.brand) && COLOR_CATEGORIES.includes(item.category);
}

// ---- ティア制入場（spec27 §1.1・2026-07-04） ----

// 1実行あたりの採用目標（保証ではない・T2/T3補充の閾値）
export const RUN_TARGET = 10;

// フィード保持上限（既存 slice(0,200) の定数化＝挙動不変・spec27 §1.4）
export const MAX_FEED_ITEMS = 200;

// T2判定: 既知ブランド × コスメ文脈語（色カテゴリ語なしでも可）
export const T2_CONTEXT_WORDS = ["限定", "復刻", "ベスコス", "ベストコスメ", "コレクション", "コフレ", "コラボ", "新作", "発売"];

// T2/T3判定にのみ適用する除外語（T1・手動キュレーションには不適用＝互換性維持）
export const T3_EXCLUDE_WORDS = ["スキンケア", "化粧水", "美容液", "クリーム", "ヘア", "シャンプー", "香水", "フレグランス", "サプリ", "ダイエット", "医療", "クリニック", "脱毛", "整形"];

// T3判定用の色カテゴリ語（sources.yml の category_rules と独立＝ソース設定に依存しない）
export const COLOR_CATEGORY_WORDS = ["リップ", "ルージュ", "ティント", "アイシャドウ", "チーク", "ネイル", "マスカラ", "アイライナー", "グロス"];

/** タイトルに色カテゴリ語を含むか（T3判定用） */
export function hasColorCategoryWord(title) {
  return COLOR_CATEGORY_WORDS.some((w) => title.includes(w));
}

// base category は COLOR_CATEGORY_WORDS に語が収録されておらず、admissionGate が
// category_rules（ファンデ/下地/パウダー等の4文字以下の短縮語を含む）だけでcategory='base'
// を確定させるため、brand=unknown の T3 判定で category フラグ単独を信用すると
// 短縮語の部分一致（例:「ファンデ」⊂「ファンデータ」）に弱い（spec32続報 2026-07-09）。
// 長く確実な語（このタイトルなら誤爆リスクがほぼ無い語）に限り単独証拠として許容する。
const RELIABLE_BASE_WORDS = ["ファンデーション", "コンシーラー", "BBクリーム", "CCクリーム"];

// 非コスメ除外語（spec32 §1.1・厳選8語＋部分文字列誤マッチ対策のdenylist）
export const NON_COSMETIC_EXCLUDE_WORDS = ["扇風機", "ハンディファン", "家電", "ガジェット", "クラウドファンディング", "和牛", "不動産", "アフタヌーンティー"];

/**
 * タイトルが明確な非コスメ記事か（spec32 §2.1・NFKC正規化はローカル比較用のみ）
 * @param {string} title
 * @returns {boolean}
 */
export function isNonCosmetic(title) {
  const t = (title ?? "").normalize("NFKC");
  return NON_COSMETIC_EXCLUDE_WORDS.some((w) => w.length > 0 && t.includes(w));
}

/**
 * ティア判定（spec27 §1.1 擬似コード・上から順に評価が正）。
 * - T1 = 現行 isDisplayQuality と完全同一（手動キュレーション or 既知ブランド×色カテゴリ）
 * - 除外語は T2/T3 判定にのみ適用（「リップクリーム」等の既知ブランド品がT1に入る互換性）
 * - 中立性（NFR6）: 判定入力は brand/category/title/color_name のみ（報酬・広告項なし）
 * @param {{ brand?: string, category?: string, color_name?: string, title?: string, ogp_title?: string }} item
 * @returns {1|2|3|null} null=不採用
 */
export function classifyTier(item) {
  const title = item.title ?? item.ogp_title ?? "";
  if (typeof item.color_name === "string" && item.color_name.length > 0) return 1; // 手動キュレーション=無条件T1
  if (isNonCosmetic(title)) return null; // 非コスメ除外（spec32 §2.2②）
  const known = isKnownBrand(item.brand);
  const hasColorCategory = COLOR_CATEGORIES.includes(item.category);
  if (known && hasColorCategory) return 1;                                  // 現行品質バーと完全同一
  if (T3_EXCLUDE_WORDS.some((w) => title.includes(w))) return null;         // 除外語はここから下のみ
  if (known && T2_CONTEXT_WORDS.some((w) => title.includes(w))) return 2;
  if (hasColorCategoryWord(title)) return 3;                                // 色カテゴリ語の直接一致は許容
  // brand=unknown の入場強化（spec32続報）: category フラグのみの証拠は、
  // base（COLOR_CATEGORY_WORDS未収録＝短縮語の部分一致に弱い）に限り
  // 長く確実な語での裏付けを必須とする。lip/eye/cheek は口紅/下地等の
  // 漢字語（衝突リスクなし）を維持するため従来通り許容する。
  if (hasColorCategory) {
    if (item.category === "base") {
      return RELIABLE_BASE_WORDS.some((w) => title.includes(w)) ? 3 : null;
    }
    return 3;
  }
  return null;
}

/**
 * ブランド名 → URL安全なスラッグ
 */
export function brandSlug(brand) {
  return brand
    .toLowerCase()
    .replace(/[&\s　]+/g, "-")
    .replace(/[^\w\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20) || "unknown";
}

// ---- 価格抽出 ----

const PRICE_REGEX = /[¥￥][\s]*([\d,]+)|(\d[\d,]+)\s*円/g;

/**
 * テキストから最初の価格（>=1）を抽出
 * @returns {{ price_jpy: number, price_label: string } | null}
 */
export function extractPrice(text) {
  PRICE_REGEX.lastIndex = 0;
  let match;
  while ((match = PRICE_REGEX.exec(text)) !== null) {
    const raw = (match[1] || match[2]).replace(/,/g, "");
    const n = parseInt(raw, 10);
    if (n >= 1) return { price_jpy: n, price_label: "公式発表価格" };
  }
  return null;
}

// ---- 多色語検出 ----

const MULTI_COLOR_WORDS = ["パレット", "デュオ", "トリオ", "クアッド", "マルチ", "セット", "コレクション"];

export function isMultiColor(text) {
  return MULTI_COLOR_WORDS.some((w) => text.includes(w));
}

// ---- 色語辞書ヒット ----

/**
 * color_dict から最初にヒットした色語のHEXを返す
 * 多色語が含まれる場合は null
 * @param {string} text
 * @param {Record<string, string>} colorDict
 * @returns {string | null}
 */
export function lookupColor(text, colorDict) {
  if (isMultiColor(text)) return null;
  for (const [word, hex] of Object.entries(colorDict)) {
    if (text.includes(word)) return hex;
  }
  return null;
}

// ---- カテゴリ判定 ----

/**
 * タイトルから category を判定
 * @param {string} title
 * @param {{ [cat: string]: string[] }} categoryRules
 * @param {string} fallback
 */
export function detectCategory(title, categoryRules, fallback) {
  for (const [cat, keywords] of Object.entries(categoryRules)) {
    if (keywords.some((kw) => categoryKeywordOccursAsWord(title, kw))) return cat;
  }
  return fallback || "info";
}

// ---- 入場ゲート ----

/**
 * 入場ゲート判定（spec23 §2 安全側設計）
 *
 * require_match=true のソースに対して:
 *   1. category_rules のいずれかのキーワードに一致 → その category で採用
 *   2. admission_info_keywords のいずれかに一致    → category='info' で採用
 *   3. どちらにも一致しない                        → skip（null を返す）
 *
 * require_match=false/未指定 → 既存挙動（detectCategory にフォールバック）
 *
 * @param {string} title
 * @param {{ require_match?: boolean, category_rules?: Record<string, string[]>, fallback_category?: string, admission_info_keywords?: string[] }} source
 * @returns {{ pass: boolean, category: string }}
 */
export function admissionGate(title, source) {
  const {
    require_match = false,
    category_rules = {},
    fallback_category = "info",
    admission_info_keywords = [],
  } = source;

  if (isNonCosmetic(title)) return { pass: false, category: "" }; // 非コスメ除外（spec32 §2.2①）

  // require_match=false: 既存挙動
  if (!require_match) {
    const category = detectCategory(title, category_rules, fallback_category);
    return { pass: true, category };
  }

  // require_match=true: ゲートあり
  // 1. category_rules にヒット（境界チェック付き・spec32続報）
  for (const [cat, keywords] of Object.entries(category_rules)) {
    if (keywords.some((kw) => categoryKeywordOccursAsWord(title, kw))) {
      return { pass: true, category: cat };
    }
  }

  // 2. admission_info_keywords にヒット → category='info' で採用
  if (admission_info_keywords.length > 0) {
    if (admission_info_keywords.some((kw) => title.includes(kw))) {
      return { pass: true, category: "info" };
    }
  }

  // 3. どちらにもヒットしない → skip
  return { pass: false, category: "" };
}

// ---- ID 生成 ----

/**
 * ID = {released_at}-{brand_slug}-{color_code_slug|color_name_slug|title_hash8}
 * spec23 §2 DR2 P2-B
 */
export function generateId(releasedAt, brand, title) {
  const bSlug = brandSlug(brand);
  // タイトルからハッシュ（再現性のある短縮ID）
  const hash = createHash("sha256").update(title).digest("hex").slice(0, 8);
  return `${releasedAt}-${bSlug}-${hash}`;
}

// ---- OGP画像取得 ----

// OGP取得用のブラウザ系UA（bot UAはCDN/WAFに403で弾かれるサイトが多いため。
// RSS取得側のUA＝ソース別 user_agent 機構はこの定数の対象外）
export const OGP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** og:xxx の meta content を抽出（property/content の属性順は両対応） */
function extractMetaContent(html, property) {
  const m =
    html.match(new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`, "i")) ||
    html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`, "i"));
  return m ? m[1] : null;
}

/** OGPテキスト正規化: エンティティデコード（既存decodeHtmlEntities再利用）→trim→maxLen超は切り詰め＋「…」。空はnull */
function normalizeOgpText(raw, maxLen) {
  if (raw == null) return null;
  const s = decodeHtmlEntities(raw).trim();
  if (s === "") return null;
  return s.length > maxLen ? s.slice(0, maxLen) + "…" : s;
}

/**
 * URLのHTMLからOGPメタ（og:image / og:title / og:description）を1回のfetchで抽出
 * - imageUrl: httpsのみ採用（従来のfetchOgpImage互換）
 * - title: 120字で切り詰め / description: 200字で切り詰め（超過時は末尾「…」）
 * @param {string} url
 * @param {Function} fetchFn
 * @returns {Promise<{ imageUrl: string|null, title: string|null, description: string|null }>}
 */
export async function fetchOgpMeta(url, fetchFn) {
  const empty = { imageUrl: null, title: null, description: null };
  if (!url.startsWith("https://")) return empty;
  try {
    const res = await fetchFn(url, {
      headers: { "User-Agent": OGP_UA },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return empty;
    const html = await res.text();
    const rawImg = extractMetaContent(html, "og:image");
    const imgUrl = rawImg ? rawImg.trim() : null;
    return {
      imageUrl: imgUrl && imgUrl.startsWith("https://") ? imgUrl : null,
      title: normalizeOgpText(extractMetaContent(html, "og:title"), 120),
      description: normalizeOgpText(extractMetaContent(html, "og:description"), 200),
    };
  } catch {
    return empty;
  }
}

// ---- RSS フェッチ ----

export async function fetchRss(url, fetchFn, userAgent) {
  const res = await fetchFn(url, {
    // ソース側で user_agent 指定があればそれを使う（WWDJAPAN は CloudFront が
    // bot風UAに403を返すためブラウザ系UA必須 — spec25 appendix §3）
    headers: { "User-Agent": userAgent || "CosmeDaburiBot/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${url}`);
  return res.text();
}

// ---- メイン処理 ----

// 1実行の新規採用上限（OGP直列取得×3回/日でtimeout-minutes:15を守る・spec25 §1.2）
export const MAX_NEW_PER_RUN = 20;

// OGPバックフィルの1実行あたり再試行上限（実行時間ガード）
export const OGP_BACKFILL_PER_RUN = 5;

/**
 * source_url 重複プルーン（自己修復）— 自動収集分の同一 source_url は1件だけ残す。
 * 残す基準:
 * - 手動キュレーション（color_name あり）は常に保持（1プレスリリース=複数色エントリが正規データのため対象外）
 * - キュレーション済みURLと重複する自動収集分は冗長として除去
 * - 自動収集分同士の同一URLは情報量（ogp_title/category/tier の充足数）が多い方を優先・同点は配列の先頭側（先勝ち）
 * 元の配列順は保持する。source_url を持たない項目は対象外（そのまま保持）。
 * @param {object[]} items
 * @returns {object[]}
 */
export function dedupeBySourceUrl(items) {
  const isCurated = (it) => typeof it.color_name === "string" && it.color_name.length > 0;
  const infoScore = (it) =>
    ["ogp_title", "category", "tier"].reduce((n, k) => n + (it[k] != null && it[k] !== "" ? 1 : 0), 0);
  const curatedUrls = new Set();
  const winners = new Map(); // source_url -> 残す自動収集item（参照比較で filter する）
  for (const it of items) {
    if (!it.source_url) continue;
    if (isCurated(it)) {
      curatedUrls.add(it.source_url);
      continue;
    }
    const prev = winners.get(it.source_url);
    if (!prev || infoScore(it) > infoScore(prev)) winners.set(it.source_url, it);
  }
  return items.filter((it) => {
    if (!it.source_url || isCurated(it)) return true;
    if (curatedUrls.has(it.source_url)) return false; // キュレーション済みと同一URLの自動収集分は冗長
    return winners.get(it.source_url) === it;
  });
}

/**
 * メインコレクター
 * @param {{ fetchFn?: Function, dryRun?: boolean, sourcesYaml?: string, existing?: { version: number, items: object[] } }} opts
 *   sourcesYaml / existing はテスト用注入（未指定なら sources.yml / v1/news.json を読む）
 */
export async function collect({
  fetchFn = fetch,
  dryRun = false,
  sourcesYaml,
  existing: injectedExisting,
} = {}) {
  const newsJsonPath = join(ROOT, "v1", "news.json");
  const manifestPath = join(ROOT, "v1", "manifest.json");
  const sourcesPath = join(ROOT, "sources.yml");
  const colorDictPath = join(ROOT, "color_dict.yml");

  // 既存データ読み込み（テスト注入があればそれを使う）
  const existing = injectedExisting ?? JSON.parse(readFileSync(newsJsonPath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const existingIds = new Set(existing.items.map((it) => it.id));
  const existingUrls = new Set(existing.items.map((it) => it.source_url));

  // sources.yml / color_dict.yml 読み込み
  const sourcesText = sourcesYaml ?? readFileSync(sourcesPath, "utf8");
  const colorDictText = readFileSync(colorDictPath, "utf8");

  const sources = parseYaml(sourcesText);
  const colorDict = parseYaml(colorDictText);

  // --- Phase 1: 全RSSを tier 判定して3候補リストに分類（spec27 §1.2） ---
  const tierCandidates = { 1: [], 2: [], 3: [] };
  const sourceStats = []; // { name, fetched } — 採用数は充足後に集計

  for (const source of sources) {
    const { name, rss_url, user_agent } = source;
    console.log(`[collect] フェッチ: ${name} (${rss_url})`);

    let xml;
    try {
      xml = await fetchRss(rss_url, fetchFn, user_agent);
    } catch (err) {
      console.error(`[collect] RSS取得失敗: ${name} — ${err.message}`);
      continue;
    }

    const rssItems = parseRss(xml);
    console.log(`[collect] ${rssItems.length}件取得`);
    sourceStats.push({ name, fetched: rssItems.length });

    for (const rssItem of rssItems) {
      const { title, link, pubDate } = rssItem;
      if (!title || !link) continue;

      // 入場ゲート判定（全ティア共通・require_match=true の場合、未一致はskip）
      const gate = admissionGate(title, source);
      if (!gate.pass) {
        console.log(`[collect] ゲートskip: "${title}"`);
        continue;
      }
      const category = gate.category;

      const releasedAt = parsePubDate(pubDate);
      const extracted = extractBrand(title);

      // ティア判定（T1=現行品質バーと完全同一・除外語はT2/T3のみ）
      const tier = classifyTier({ brand: extracted, category, title });
      if (tier === null) {
        console.log(`[collect] tier不採用: brand=${extracted} category=${category} "${title}"`);
        continue;
      }

      // T3 の brand は 'unknown' 固定（辞書外の先頭語フォールバックは表示品質に耐えない・spec27 §1.3b）
      const brand = tier === 3 ? "unknown" : extracted;
      const id = generateId(releasedAt, brand, title);

      // 既存IDスキップ
      if (existingIds.has(id)) continue;
      existingIds.add(id); // run内dedupe: 同一実行内の後続ソースが同じidを再採用しない（spec25 §1.2）

      // 入場時URL dedupe: 既存items・同一run内の先行候補と source_url が一致する候補は不採用
      // （idはブランド/タイトル差で別になり得るため、URL一致を独立に弾く＝重複カード防止）
      if (existingUrls.has(link)) continue;
      existingUrls.add(link);

      tierCandidates[tier].push({ sourceName: name, title, link, releasedAt, brand, category, tier, id });
    }
  }

  // --- Phase 2: 充足（T1全件→RUN_TARGETまでT2新しい順→T3新しい順→MAX_NEW_PER_RUN上限） ---
  // 中立性（NFR6）: 補充順は tier と released_at のみで決める（広告・報酬・特定ブランド優遇なし）
  const byNewest = (a, b) => (b.releasedAt > a.releasedAt ? 1 : b.releasedAt < a.releasedAt ? -1 : 0);
  tierCandidates[1].sort(byNewest);
  tierCandidates[2].sort(byNewest);
  tierCandidates[3].sort(byNewest);

  const selected = tierCandidates[1].slice(0, MAX_NEW_PER_RUN);
  if (selected.length < RUN_TARGET) {
    for (const cand of tierCandidates[2]) {
      if (selected.length >= RUN_TARGET) break;
      selected.push(cand);
    }
  }
  if (selected.length < RUN_TARGET) {
    for (const cand of tierCandidates[3]) {
      if (selected.length >= RUN_TARGET) break; // T3もRUN_TARGETまで（spec §1.2・T2と対称。最終レビュー確認済み）
      selected.push(cand);
    }
  }

  // --- Phase 3: 採用アイテム生成（価格・色語・OGPは選抜後のみ＝OGP取得は最大20件/run） ---
  const newItems = [];
  const adoptedBySource = new Map();

  for (const cand of selected) {
    const { title, link, releasedAt, brand, category, tier, id } = cand;

    // 価格抽出
    const priceResult = extractPrice(title);

    // 色語辞書ヒット
    const hexValue = lookupColor(title, colorDict);

    // OGPメタ取得（画像＋リンクプレビュー用title/description・1回のfetch）
    const ogpMeta = await fetchOgpMeta(link, fetchFn);

    // アイテム生成 — note は常に '' （spec23 §2）
    const item = {
      id,
      brand,
      product_line: "",    // タイトルから機械的に確定できない場合は空
      color_code: null,
      color_name: null,
      hex: hexValue || null,
      hex_origin: hexValue ? "estimated" : null,
      released_at: releasedAt,
      source_url: link,
      note: "",             // 常に空文字（非空ならCIでfail）
      category,
      tier,
      ...(ogpMeta.imageUrl ? { ogp_image_url: ogpMeta.imageUrl } : {}),
      ogp_title: ogpMeta.title,
      ogp_description: ogpMeta.description,
      ...(priceResult ? { price_jpy: priceResult.price_jpy, price_label: priceResult.price_label } : {}),
    };

    // null フィールド削除（オプショナル列）
    for (const key of ["color_code", "color_name", "hex", "hex_origin"]) {
      if (item[key] === null) delete item[key];
    }

    // note が空でないならCI fail（spec23 §8）
    if (item.note !== "") {
      console.error(`[collect] FATAL: note が空でないアイテムが生成されました: id=${id}`);
      process.exit(1);
    }

    newItems.push(item);
    adoptedBySource.set(cand.sourceName, (adoptedBySource.get(cand.sourceName) || 0) + 1);
  }

  for (const { name, fetched } of sourceStats) {
    console.log(`[collect] source=${name} fetched=${fetched} adopted=${adoptedBySource.get(name) || 0}`);
  }

  // 既存フィードの自己修復プルーン（tier基準・spec27 §1.1 改修方針2）
  // tier付きで採用した項目はT2/T3でも正規メンバーとして保持。
  // tier欠落は classifyTier で再判定し、null=除去・非null=tier付与して保存。
  const keptExisting = [];
  let prunedCount = 0;
  for (const it of existing.items) {
    const isCurated = typeof it.color_name === "string" && it.color_name.length > 0;
    if (!isCurated && isNonCosmetic(it.title ?? it.ogp_title ?? "")) {
      prunedCount++;
      continue;
    }
    const tier = it.tier ?? classifyTier(it);
    if (tier === null) {
      prunedCount++;
      continue;
    }
    if (it.tier == null) it.tier = tier;
    keptExisting.push(it);
  }
  if (prunedCount > 0) {
    console.log(`[collect] tierプルーン: 既存${prunedCount}件を除去`);
  }

  // source_url 重複プルーン（自己修復）: 過去runで混入した同一URL重複を1件に統合
  const dedupedExisting = dedupeBySourceUrl(keptExisting);
  const urlPrunedCount = keptExisting.length - dedupedExisting.length;
  if (urlPrunedCount > 0) {
    console.log(`[collect] URL重複プルーン: 既存${urlPrunedCount}件を除去`);
    prunedCount += urlPrunedCount;
  }

  // マージ: 新規アイテムを先頭に追加
  const merged = [...newItems, ...dedupedExisting];

  // OGPバックフィル: image/title/description のいずれかが欠けた項目を再試行（上限 OGP_BACKFILL_PER_RUN 件/run）
  // 収集時に1回失敗すると永久に欠落したままだった問題への恒久対策。取得できたフィールドだけ埋め、既存値は上書きしない
  const backfillTargets = merged.filter(
    (it) => it.ogp_image_url == null || it.ogp_title == null || it.ogp_description == null
  );
  let backfilledCount = 0;
  for (const it of backfillTargets.slice(0, OGP_BACKFILL_PER_RUN)) {
    const meta = await fetchOgpMeta(it.source_url, fetchFn);
    let updated = false;
    if (it.ogp_image_url == null && meta.imageUrl) {
      it.ogp_image_url = meta.imageUrl;
      updated = true;
    }
    if (it.ogp_title == null && meta.title) {
      it.ogp_title = meta.title;
      updated = true;
    }
    if (it.ogp_description == null && meta.description) {
      it.ogp_description = meta.description;
      updated = true;
    }
    if (updated) {
      backfilledCount++;
      if (dryRun) {
        console.log(`[collect] ogp-backfill(dryRun): 更新予定 id=${it.id}`);
      }
    }
  }
  console.log(`[collect] ogp-backfill: 対象${backfillTargets.length}件中 ${backfilledCount}件更新`);

  // このrunの採用内訳（Summary観測用・spec27 §1.5）
  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const it of newItems) tierCounts[it.tier]++;
  console.log(`[collect] tiers: tier1=${tierCounts[1]} tier2=${tierCounts[2]} tier3=${tierCounts[3]}`);

  if (newItems.length === 0 && prunedCount === 0 && backfilledCount === 0) {
    console.log("[collect] 新規アイテムなし。変更しません。");
    return { added: 0, total: existing.items.length, backfilled: 0, items: existing.items };
  }

  // 保持上限（古い順間引き）— released_at 降順ソート後に先頭 MAX_FEED_ITEMS 件（spec27 §1.4・挙動不変）
  merged.sort((a, b) => (b.released_at > a.released_at ? 1 : b.released_at < a.released_at ? -1 : 0));
  const trimmed = merged.slice(0, MAX_FEED_ITEMS);

  const newVersion = (manifest.version || 0) + 1;
  const generatedAt = new Date().toISOString();

  const updatedNews = {
    version: newVersion,
    generated_at: generatedAt,
    items: trimmed,
  };

  const updatedManifest = {
    version: newVersion,
    generated_at: generatedAt,
  };

  if (!dryRun) {
    writeFileSync(newsJsonPath, JSON.stringify(updatedNews, null, 2) + "\n", "utf8");
    writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2) + "\n", "utf8");
    console.log(`[collect] 完了: +${newItems.length}件追加 合計${trimmed.length}件 version=${newVersion}`);
  } else {
    console.log(`[collect] dryRun: +${newItems.length}件追加予定`);
  }

  return { added: newItems.length, total: trimmed.length, version: newVersion, backfilled: backfilledCount, items: trimmed };
}

// ---- CLI エントリポイント ----

// import.meta.url がメインスクリプトなら実行
const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  collect({ dryRun }).catch((err) => {
    console.error("[collect] 予期しないエラー:", err);
    process.exit(1);
  });
}
