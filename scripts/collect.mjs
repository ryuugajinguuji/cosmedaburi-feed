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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
        if (kv.value === null) {
          // ブロック値
          const sub = parseYamlLines(lines, i + 1, indent + 2);
          const obj = {};
          obj[kv.key] = sub.value;
          i = sub.nextIndex;
          // キーと値の辞書として返す場合
          return { value: buildDict(lines, startIndex, baseIndent), nextIndex: lines.length };
        } else {
          // フラットな辞書として収集
          return { value: buildDict(lines, startIndex, baseIndent), nextIndex: lines.length };
        }
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
  return dict;
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

/**
 * タイトルからブランド名を機械的に抽出（既知ブランド優先）
 */
export function extractBrand(title) {
  for (const brand of KNOWN_BRANDS) {
    if (title.includes(brand)) return brand;
  }
  // 「ブランド名」 の形式を探す
  const m = title.match(/^([^\s　「」【】（）\[\]]{2,20}?)[　\s]/);
  if (m) return m[1];
  return "unknown";
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

/**
 * メインコレクター
 * @param {{ fetchFn?: Function, dryRun?: boolean }} opts
 */
export async function collect({ fetchFn = fetch, dryRun = false } = {}) {
  const newsJsonPath = join(ROOT, "v1", "news.json");
  const manifestPath = join(ROOT, "v1", "manifest.json");
  const sourcesPath = join(ROOT, "sources.yml");
  const colorDictPath = join(ROOT, "color_dict.yml");

  // 既存データ読み込み
  const existing = JSON.parse(readFileSync(newsJsonPath, "utf8"));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const existingIds = new Set(existing.items.map((it) => it.id));

  // sources.yml / color_dict.yml 読み込み
  const sourcesText = readFileSync(sourcesPath, "utf8");
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

    for (const rssItem of rssItems) {
      const { title, link, pubDate } = rssItem;
      if (!title || !link) continue;

      const releasedAt = parsePubDate(pubDate);
      const brand = extractBrand(title);
      const id = generateId(releasedAt, brand, title);

      // 既存IDスキップ
      if (existingIds.has(id)) continue;

      // カテゴリ判定
      const category = detectCategory(title, category_rules || {}, fallback_category || "info");

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

      newItems.push(item);
    }
  }

  if (newItems.length === 0) {
    console.log("[collect] 新規アイテムなし。変更しません。");
    return { added: 0, total: existing.items.length };
  }

  // マージ: 新規アイテムを先頭に追加
  const merged = [...newItems, ...existing.items];

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
  fileURLToPath(import.meta.url) === process.argv[1].replace(/\\/g, "/");

if (isMain) {
  collect().catch((err) => {
    console.error("[collect] 予期しないエラー:", err);
    process.exit(1);
  });
}
