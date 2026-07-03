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

// 日本コスメ頻出ブランド名（スラッグ生成用）
const KNOWN_BRANDS = [
  "NARS", "CANMAKE", "KATE", "OPERA", "Pyt",
  "セザンヌ", "ちふれ", "エテュセ", "UZU", "rom&nd",
  "CEZANNE", "INTEGRATE", "REVLON", "MAC", "RMK",
  "LUNASOL", "ADDICTION", "SUQQU", "PAUL & JOE",
  "THREE", "DECORTE", "CHICCA", "JILL STUART",
  "アンプリチュード", "リンメル", "コーセー", "資生堂",
  "花王", "ソフィーナ", "マキアージュ", "エスト",
  "ローラ メルシエ", "ナーズ", "ランコム", "イプサ",
];

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
    if (keywords.some((kw) => title.includes(kw))) return cat;
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

  // require_match=false: 既存挙動
  if (!require_match) {
    const category = detectCategory(title, category_rules, fallback_category);
    return { pass: true, category };
  }

  // require_match=true: ゲートあり
  // 1. category_rules にヒット
  for (const [cat, keywords] of Object.entries(category_rules)) {
    if (keywords.some((kw) => title.includes(kw))) {
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

/**
 * URLのHTMLからog:imageを抽出（httpsのみ）
 * @param {string} url
 * @param {Function} fetchFn
 * @returns {Promise<string | null>}
 */
export async function fetchOgpImage(url, fetchFn) {
  if (!url.startsWith("https://")) return null;
  try {
    const res = await fetchFn(url, {
      headers: { "User-Agent": "CosmeDaburiBot/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (!m) return null;
    const imgUrl = m[1].trim();
    return imgUrl.startsWith("https://") ? imgUrl : null;
  } catch {
    return null;
  }
}

// ---- RSS フェッチ ----

export async function fetchRss(url, fetchFn) {
  const res = await fetchFn(url, {
    headers: { "User-Agent": "CosmeDaburiBot/1.0" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status} ${url}`);
  return res.text();
}

// ---- メイン処理 ----

// 1実行の新規採用上限（OGP直列取得×3回/日でtimeout-minutes:15を守る・spec25 §1.2）
export const MAX_NEW_PER_RUN = 20;

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

  // sources.yml / color_dict.yml 読み込み
  const sourcesText = sourcesYaml ?? readFileSync(sourcesPath, "utf8");
  const colorDictText = readFileSync(colorDictPath, "utf8");

  const sources = parseYaml(sourcesText);
  const colorDict = parseYaml(colorDictText);

  const newItems = [];

  for (const source of sources) {
    const { name, rss_url, category_rules, fallback_category } = source;
    console.log(`[collect] フェッチ: ${name} (${rss_url})`);

    let xml;
    try {
      xml = await fetchRss(rss_url, fetchFn);
    } catch (err) {
      console.error(`[collect] RSS取得失敗: ${name} — ${err.message}`);
      continue;
    }

    const rssItems = parseRss(xml);
    console.log(`[collect] ${rssItems.length}件取得`);

    let adoptedForSource = 0;

    for (const rssItem of rssItems) {
      // 1実行の新規採用上限（spec25 §1.2）
      if (newItems.length >= MAX_NEW_PER_RUN) break;

      const { title, link, pubDate } = rssItem;
      if (!title || !link) continue;

      const releasedAt = parsePubDate(pubDate);
      const brand = extractBrand(title);
      const id = generateId(releasedAt, brand, title);

      // 既存IDスキップ
      if (existingIds.has(id)) continue;

      // 入場ゲート判定（require_match=true の場合、未一致はskip）
      const gate = admissionGate(title, source);
      if (!gate.pass) {
        console.log(`[collect] ゲートskip: "${title}"`);
        continue;
      }
      const category = gate.category;

      // 価格抽出
      const priceResult = extractPrice(title);

      // 色語辞書ヒット
      const hexValue = lookupColor(title, colorDict);

      // OGP画像取得
      const ogpImageUrl = await fetchOgpImage(link, fetchFn);

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
        ...(ogpImageUrl ? { ogp_image_url: ogpImageUrl } : {}),
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

      // 表示品質バー（既知ブランド×色カテゴリのみ・2026-07-02）
      if (!isDisplayQuality(item)) {
        console.log(`[collect] 品質バーskip: brand=${item.brand} category=${item.category} "${title}"`);
        continue;
      }

      newItems.push(item);
      existingIds.add(id); // run内dedupe: 同一実行内の後続ソースが同じidを再採用しない（spec25 §1.2）
      adoptedForSource++;
    }

    console.log(`[collect] source=${name} fetched=${rssItems.length} adopted=${adoptedForSource}`);
  }

  // 既存フィードの自己修復プルーン（過去に品質バー未満で入ったアイテムを除去）
  const keptExisting = existing.items.filter(isDisplayQuality);
  const prunedCount = existing.items.length - keptExisting.length;
  if (prunedCount > 0) {
    console.log(`[collect] 品質バープルーン: 既存${prunedCount}件を除去`);
  }

  if (newItems.length === 0 && prunedCount === 0) {
    console.log("[collect] 新規アイテムなし。変更しません。");
    return { added: 0, total: existing.items.length };
  }

  // マージ: 新規アイテムを先頭に追加
  const merged = [...newItems, ...keptExisting];

  // 上限200（古い順間引き）— released_at 降順ソート後に先頭200件
  merged.sort((a, b) => (b.released_at > a.released_at ? 1 : b.released_at < a.released_at ? -1 : 0));
  const trimmed = merged.slice(0, 200);

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

  return { added: newItems.length, total: trimmed.length, version: newVersion };
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
