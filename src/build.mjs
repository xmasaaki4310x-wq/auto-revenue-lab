import { mkdir, readFile, writeFile, copyFile, cp, rm } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const root = process.cwd();
const outDir = path.join(root, "site");
const offline = process.argv.includes("--offline");
const execFile = promisify(execFileCallback);

const config = JSON.parse(await readFile(path.join(root, "src", "config.json"), "utf8"));
const samples = JSON.parse(await readFile(path.join(root, "src", "sample-products.json"), "utf8"));
const now = new Date();
const season = getSeason(now);
const diagnostics = [];
let lastRakutenRequestAt = 0;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await copyFile(path.join(root, "src", "styles.css"), path.join(outDir, "styles.css"));
await cp(path.join(root, "src", "assets"), path.join(outDir, "assets"), { recursive: true });
await cp(path.join(root, "bichiku"), path.join(outDir, "bichiku"), { recursive: true });

const keysPresent = hasRakutenKeys(config) && !offline;
const topicResults = {};
let liveTopicCount = 0;
const rakutenAuth = keysPresent
  ? await checkRakutenAccess(config)
  : { ok: false, mode: "none", reason: offline ? "offline-mode" : "missing-keys" };

for (const topic of config.topics) {
  const fetchResult = rakutenAuth.ok
    ? await fetchTopicItems(topic, config, rakutenAuth.mode)
    : { source: "sample", items: [], keyword: null, reason: rakutenAuth.reason };

  const source = fetchResult.items.length ? "live" : "sample";
  if (source === "live") liveTopicCount += 1;

  const rawItems = source === "live" ? fetchResult.items : samples[topic.slug] || [];
  const scoredItems = rawItems
    .map((raw) => normalizeItem(raw, topic, source))
    .filter((item) => item.name)
    .map((item) => source === "sample" ? { ...item, url: "", directUrl: "" } : item)
    .filter((item) => isAllowedTopicItem(topic, item))
    .filter(createNormalizedItemDeduper(topic))
    .map((item) => ({ ...item, score: scoreItem(item) }))
    .sort((a, b) => b.score - a.score);

  const qualityItems = scoredItems.filter(isPreferredItem);
  const reviewedItems = scoredItems.filter(hasAnyReview);
  const normalizedItems = (qualityItems.length >= 3 ? qualityItems : reviewedItems.length >= 3 ? reviewedItems : scoredItems)
    .slice(0, config.maxItemsPerTopic);

  topicResults[topic.slug] = {
    items: normalizedItems,
    source,
    keyword: fetchResult.keyword,
    reason: fetchResult.reason
  };

  if (rakutenAuth.ok) {
    await wait(600);
  }
}

removeCrossCategoryDuplicates(topicResults, config.topics);

for (const topic of config.topics) {
  const result = topicResults[topic.slug] || { items: [], source: "sample", keyword: null, reason: "missing-result" };
  diagnostics.push({
    slug: topic.slug,
    source: result.source,
    keyword: result.keyword,
    reason: result.reason,
    count: result.items.length
  });

  await writeTopicPage(topic, result.items, result.source);
}

const dataMode = liveTopicCount === 0 ? "sample" : liveTopicCount === config.topics.length ? "live" : "mixed";

await writeHomePage(topicResults, dataMode);
await writeRankingPage(topicResults, dataMode);
await writeIntentPage(topicResults, dataMode);
await writeGuidesPage(topicResults, dataMode);
await writeStaticPages();
await writeJsonFeed(topicResults, dataMode);
await writeBuildReport(dataMode);
await writeCname();
await writeSitemap();

console.log(`Built ${outDir}${dataMode === "live" ? " using Rakuten API" : " using sample/fallback data"}.`);

function hasRakutenKeys(siteConfig) {
  const rakuten = siteConfig.rakuten;
  return Boolean(
    getEnvValue(rakuten.applicationIdEnv) &&
    getEnvValue(rakuten.accessKeyEnv)
  );
}

async function checkRakutenAccess(siteConfig) {
  const testKeyword = "水";
  let lastReason = "auth-check-failed";

  try {
    await fetchRakutenItems(testKeyword, siteConfig, true, { hits: 1, accessKeyMode: "query" });
    return { ok: true, mode: "query", reason: "auth-ok-query" };
  } catch (error) {
    lastReason = `auth-check query: ${error.message}`;
    console.warn(`Rakuten auth check failed: ${error.message}`);
  }

  return { ok: false, mode: "none", reason: lastReason };
}

async function fetchTopicItems(topic, siteConfig, accessKeyMode) {
  const maxKeywords = Math.max(1, Math.min(Number(topic.maxKeywords || siteConfig.rakuten?.maxKeywordsPerTopic || 4), 6));
  const keywords = [topic.keyword, ...(topic.fallbackKeywords || [])]
    .map((keyword) => String(keyword || "").trim())
    .filter(Boolean)
    .slice(0, maxKeywords);
  let lastReason = "no-results";
  const collected = [];
  const usedKeywords = [];
  const addKeyword = (keyword) => {
    if (!usedKeywords.includes(keyword)) usedKeywords.push(keyword);
  };
  const targetCount = Math.min(Math.max(siteConfig.maxItemsPerTopic || 12, 10), 15);

  const runSearchPass = async (relaxed) => {
    for (const keyword of keywords) {
      try {
        const items = filterRawItemsForTopic(topic, await fetchRakutenItems(keyword, siteConfig, relaxed, { accessKeyMode, hits: 24 }));
        if (items.length) {
          collected.push(...items);
          addKeyword(keyword);
          lastReason = relaxed ? "merged-relaxed-partial" : "merged-primary-partial";
          if (relaxed && dedupeRawItems(collected, topic).length >= targetCount) return "enough";
        }
        lastReason = relaxed ? "relaxed-empty" : "primary-empty";
      } catch (error) {
        lastReason = error.message;
        console.warn(`Rakuten fetch failed for ${keyword}: ${error.message}`);
        if (error.message.includes("HTTP 403") || error.message.includes("HTTP 429")) {
          const merged = dedupeRawItems(collected, topic);
          if (merged.length) {
            return {
              source: "live",
              items: merged,
              keyword: usedKeywords.join(" / "),
              reason: `${lastReason}; partial-live`
            };
          }
          return { source: "sample", items: [], keyword: null, reason: error.message };
        }
      }
      await wait(relaxed ? 350 : 250);
    }
    return null;
  };

  const strictResult = await runSearchPass(false);
  if (strictResult?.source) return strictResult;

  if (dedupeRawItems(collected, topic).length < targetCount) {
    const relaxedResult = await runSearchPass(true);
    if (relaxedResult?.source) return relaxedResult;
  }

  const merged = dedupeRawItems(collected, topic);
  if (merged.length) {
    return {
      source: "live",
      items: merged,
      keyword: usedKeywords.join(" / "),
      reason: usedKeywords.length > 1 ? "merged-multi-keyword" : lastReason
    };
  }

  return {
    source: "sample",
    items: [],
    keyword: null,
    reason: lastReason
  };
}

function filterRawItemsForTopic(topic, items) {
  const excludes = (topic.excludeKeywords || []).map((keyword) => normalizeForMatching(keyword)).filter(Boolean);
  if (!excludes.length) return items;
  return items.filter((item) => {
    const text = normalizeForMatching([
      item.itemName,
      item.itemCaption,
      item.shopName
    ].filter(Boolean).join(" "));
    return !excludes.some((keyword) => text.includes(keyword));
  });
}

function dedupeRawItems(items, topic = {}) {
  const seen = new Set();
  const seenSimilar = new Set();
  const result = [];
  for (const item of items) {
    const key = String(item.itemCode || item.itemUrl || item.affiliateUrl || item.itemName || "").trim();
    if (!key || seen.has(key)) continue;
    const similarKey = createSimilarItemKey(item.itemName, item.shopName, topic.slug);
    if (similarKey && seenSimilar.has(similarKey)) continue;
    seen.add(key);
    if (similarKey) seenSimilar.add(similarKey);
    result.push(item);
  }
  return result;
}

function removeCrossCategoryDuplicates(topicResults, topics) {
  const groups = new Map();

  for (const topic of topics) {
    const result = topicResults[topic.slug];
    if (!result?.items?.length) continue;
    result.items.forEach((item, index) => {
      const key = createGlobalItemKey(item);
      if (!key) return;
      const candidates = groups.get(key) || [];
      candidates.push({
        topic,
        item,
        index,
        fit: scoreTopicFit(topic, item)
      });
      groups.set(key, candidates);
    });
  }

  const allowed = new Map(topics.map((topic) => [topic.slug, new Set()]));
  for (const candidates of groups.values()) {
    const winner = candidates
      .sort((a, b) => b.fit - a.fit || b.item.score - a.item.score || a.index - b.index)[0];
    allowed.get(winner.topic.slug)?.add(winner.item);
  }

  for (const topic of topics) {
    const result = topicResults[topic.slug];
    if (!result?.items?.length) continue;
    const keep = allowed.get(topic.slug);
    result.items = result.items
      .filter((item) => keep?.has(item))
      .slice(0, config.maxItemsPerTopic);
    result.reason = result.reason ? `${result.reason}; cross-category-deduped` : "cross-category-deduped";
  }
}

function createGlobalItemKey(item) {
  const stableUrl = String(item.directUrl || item.url || "").replace(/\?.*$/, "");
  if (stableUrl) return `url:${stableUrl}`;
  const normalizedName = normalizeForMatching(cleanDisplayText(item.name))
    .replace(/送料無料|送料込み|ポイント\d+倍|ポイント最大\d+倍|クーポン|SALE|セール|よりどり|選べる|訳あり|ランキング|楽天|市場/g, "")
    .replace(/[0-9０-９]+(個|本|枚|袋|箱|セット|kg|g|ml|l|L|人前|食|切|尾|粒|回|泊|cm|mm)/gi, "");
  return normalizedName ? `name:${normalizedName.slice(0, 34)}` : "";
}

function scoreTopicFit(topic, item) {
  const itemText = normalizeForMatching([item.name, item.caption].filter(Boolean).join(" "));
  const tokens = [
    topic.title,
    topic.keyword,
    ...(topic.fallbackKeywords || [])
  ]
    .flatMap((value) => String(value || "").split(/[\s　・,、]+/))
    .map(normalizeForMatching)
    .filter((token) => token.length >= 2);

  let score = 0;
  for (const token of new Set(tokens)) {
    if (itemText.includes(token)) score += token.length >= 4 ? 3 : 1.5;
  }

  if (topic.slug === "cleaning-laundry" && /(洗濯|洗剤|掃除|カビ|除湿|アタック|漂白)/.test(item.name)) score += 5;
  if (topic.slug === "daily-essentials" && /(トイレット|ティッシュ|紙|日用品|消耗品)/.test(item.name)) score += 4;
  if (topic.slug === "rice-pantry" && /(米|ごはん|レトルト|缶詰|乾麺|常温|保存食|インスタント)/.test(item.name)) score += 4;
  if (topic.slug === "otoriyose-gourmet" && /(鮭|ホタテ|蟹|カニ|うなぎ|干物|海鮮|魚介|切り身|冷凍)/.test(item.name)) score += 5;

  return score;
}

async function fetchRakutenItems(keyword, siteConfig, relaxed = false, options = {}) {
  const rakuten = siteConfig.rakuten;
  const accessKeyMode = options.accessKeyMode || "query";
  const params = new URLSearchParams({
    applicationId: getEnvValue(rakuten.applicationIdEnv),
    affiliateId: getEnvValue(rakuten.affiliateIdEnv),
    keyword,
    format: "json",
    formatVersion: "2",
    hits: String(options.hits || siteConfig.maxItemsPerTopic)
  });

  if (accessKeyMode === "query") {
    params.set("accessKey", getEnvValue(rakuten.accessKeyEnv));
  }

  const endpoint = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?${params}`;
  const referer = `${siteConfig.baseUrl.replace(/\/$/, "")}/`;
  const origin = new URL(siteConfig.baseUrl).origin;

  return fetchRakutenItemsWithCurl(endpoint, referer, origin);
}

async function fetchRakutenItemsWithCurl(endpoint, referer, origin, retries = 2) {
  await waitForRakutenSlot();
  const args = [
    "-sS",
    "-L",
    "-A",
    "Mozilla/5.0",
    "-e",
    referer,
    "-H",
    `Origin: ${origin}`,
    "-w",
    "\nHTTP_STATUS:%{http_code}",
    endpoint
  ];

  const { stdout } = await execFile("curl", args, { maxBuffer: 1024 * 1024 * 8 });
  const statusMatch = stdout.match(/\nHTTP_STATUS:(\d+)\s*$/);
  const status = statusMatch ? Number(statusMatch[1]) : 0;
  const body = statusMatch ? stdout.slice(0, statusMatch.index) : stdout;

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`curl HTTP ${status || "unknown"}: non-json-response`);
  }

  if (status < 200 || status >= 300) {
    if (status === 429 && retries > 0) {
      await wait(3500);
      return fetchRakutenItemsWithCurl(endpoint, referer, origin, retries - 1);
    }
    const message = data.error_description || data.error || data.message;
    throw new Error(message ? `curl HTTP ${status}: ${message}` : `curl HTTP ${status}`);
  }

  return extractRakutenItems(data);
}

function extractRakutenItems(data) {
  if (Array.isArray(data.items)) {
    return data.items.map((entry) => entry.Item || entry);
  }
  if (Array.isArray(data.Items)) {
    return data.Items.map((entry) => entry.Item || entry);
  }
  return [];
}

async function waitForRakutenSlot() {
  const minimumGapMs = 2600;
  const elapsed = Date.now() - lastRakutenRequestAt;
  if (elapsed < minimumGapMs) {
    await wait(minimumGapMs - elapsed);
  }
  lastRakutenRequestAt = Date.now();
}

async function formatRakutenError(response) {
  const status = `HTTP ${response.status}`;
  try {
    const text = await response.text();
    const data = JSON.parse(text);
    const message = data.error_description || data.error || data.message;
    return message ? `${status}: ${message}` : status;
  } catch {
    return status;
  }
}

function normalizeItem(raw, topic, source) {
  const reviewAverage = Number(raw.reviewAverage || 0);
  const reviewCount = Number(raw.reviewCount || 0);
  const affiliateRate = Number(raw.affiliateRate || 0);
  const price = Number(raw.itemPrice || 0);
  const name = cleanDisplayText(String(raw.itemName || ""));

  return {
    name,
    price,
    url: String(raw.affiliateUrl || raw.itemUrl || "").trim(),
    directUrl: String(raw.itemUrl || "").trim(),
    imageUrl: resolveImageUrl(raw, topic, source),
    reviewAverage,
    reviewCount,
    affiliateRate,
    caption: cleanCaption(raw.itemCaption || ""),
    shopName: cleanDisplayText(String(raw.shopName || "")),
    reason: makeReason({ reviewAverage, reviewCount, price }),
    fallbackUrl: buildRakutenSearchUrl(name || topic.keyword),
    source
  };
}

function buildRakutenSearchUrl(value) {
  const query = String(value || "").trim();
  return query ? `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(query)}/` : "https://search.rakuten.co.jp/";
}

function resolveImageUrl(raw, topic, source) {
  const candidate = getFirstImageUrl(raw).replace("?_ex=128x128", "");
  if (source === "live" && candidate && !candidate.includes("placehold.co")) {
    return candidate;
  }
  return createTopicArt(topic, String(raw.itemName || "").trim());
}

function getFirstImageUrl(raw) {
  const imageGroups = [
    raw.mediumImageUrls,
    raw.smallImageUrls,
    raw.imageUrls
  ];

  for (const group of imageGroups) {
    if (!Array.isArray(group) || !group.length) continue;
    const first = group[0];
    if (typeof first === "string") return first;
    if (first?.imageUrl) return String(first.imageUrl);
  }

  return String(raw.mediumImageUrl || raw.smallImageUrl || raw.imageUrl || "");
}

function createTopicArt(topic, title) {
  const palettes = {
    daily: ["#dff1eb", "#0f5b54", "#1e726a"],
    stock: ["#f5eedb", "#6d4e12", "#b2861d"],
    season: ["#fae7dd", "#7c2f1f", "#ca5e39"],
    fresh: ["#e7f2f4", "#164b58", "#4c8b91"],
    utility: ["#e9edf6", "#243b5b", "#52749c"],
    rest: ["#f0eaf6", "#4a3762", "#8a6ead"]
  };
  const [bg, ink, accent] = palettes[topic.accent] || palettes.daily;
  const safeTitle = escapeHtml(truncate(title || topic.title, 28));
  const badge = escapeHtml(topic.title);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="720" height="540" viewBox="0 0 720 540">
      <rect width="720" height="540" fill="${bg}"/>
      <circle cx="602" cy="96" r="84" fill="${accent}" opacity="0.16"/>
      <circle cx="110" cy="438" r="116" fill="${accent}" opacity="0.10"/>
      <path d="M0 428 C120 360, 270 356, 420 418 S650 500, 720 448 V540 H0 Z" fill="${accent}" opacity="0.18"/>
      <rect x="42" y="42" width="236" height="42" rx="21" fill="#ffffff" opacity="0.92"/>
      <text x="64" y="69" font-family="Segoe UI, sans-serif" font-size="22" font-weight="700" fill="${accent}">${badge}</text>
      <text x="50" y="246" font-family="Segoe UI, sans-serif" font-size="42" font-weight="800" fill="${ink}">${safeTitle}</text>
      <text x="50" y="302" font-family="Segoe UI, sans-serif" font-size="20" fill="${ink}" opacity="0.72">Sample preview</text>
      <rect x="50" y="350" width="150" height="18" rx="9" fill="${accent}" opacity="0.72"/>
      <rect x="50" y="382" width="220" height="18" rx="9" fill="${accent}" opacity="0.35"/>
      <rect x="50" y="414" width="180" height="18" rx="9" fill="${accent}" opacity="0.2"/>
    </svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function scoreItem(item) {
  const reviewWeight = Math.log10(item.reviewCount + 1) * 22;
  const ratingWeight = item.reviewAverage * 16;
  const priceBalance = item.price > 0 && item.price <= 5000 ? 10 : item.price <= 12000 ? 5 : 0;
  const rateWeight = item.affiliateRate * 2;
  return Math.round((reviewWeight + ratingWeight + priceBalance + rateWeight) * 10) / 10;
}

function isPreferredItem(item) {
  if (item.source === "sample") return true;
  return item.price > 0 &&
    item.reviewAverage >= config.rakuten.minReviewAverage &&
    item.reviewCount >= config.rakuten.minReviewCount;
}

function hasAnyReview(item) {
  if (item.source === "sample") return true;
  return item.price > 0 && item.reviewAverage > 0 && item.reviewCount > 0;
}

function isAllowedTopicItem(topic, item) {
  const excludes = (topic.excludeKeywords || []).map((keyword) => normalizeForMatching(keyword)).filter(Boolean);
  if (!excludes.length) return true;
  const text = normalizeForMatching([item.name, item.caption, item.shopName].filter(Boolean).join(" "));
  return !excludes.some((keyword) => text.includes(keyword));
}

function createNormalizedItemDeduper(topic) {
  const seenNames = new Set();
  const seenSimilar = new Set();
  return (item) => {
    const nameKey = normalizeForMatching(item.name);
    if (!nameKey || seenNames.has(nameKey)) return false;
    const similarKey = createSimilarItemKey(item.name, item.shopName, topic.slug);
    if (similarKey && seenSimilar.has(similarKey)) return false;
    seenNames.add(nameKey);
    if (similarKey) seenSimilar.add(similarKey);
    return true;
  };
}

function cleanDisplayText(value) {
  return stripHtml(String(value || "").normalize("NFKC"))
    .replace(/[【\[\(（]?\s*(受付番号|ログインID|閲覧ID|管理番号|商品番号|申込番号)\s*[:：]\s*[A-Za-z0-9_-]+\s*[】\]\)）]?/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanCaption(value) {
  return cleanDisplayText(value)
    .replace(/(受付番号|ログインID|閲覧ID|管理番号|商品番号|申込番号)\s*[:：]\s*[A-Za-z0-9_-]+/gi, " ")
    .replace(/(カタログ管理用|カタログ掲載用)[^。.\n\r]*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function normalizeForMatching(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[・･\-_/【】［］\[\]（）()「」『』,，、。.!！?？:：]/g, "");
}

function createSimilarItemKey(name, shopName = "", slug = "") {
  const normalizedName = normalizeForMatching(cleanDisplayText(name))
    .replace(/送料無料|送料込み|ポイント\d+倍|ポイント最大\d+倍|クーポン|SALE|セール|よりどり|選べる|訳あり|ランキング|楽天|市場/g, "")
    .replace(/[0-9０-９]+(個|本|枚|袋|箱|セット|kg|g|ml|l|L|人前|食|切|尾|粒|回|泊|cm|mm)/gi, "");
  if (!normalizedName) return "";
  const normalizedShop = normalizeForMatching(shopName).slice(0, 24);
  const prefixLength = slug === "otoriyose-gourmet" ? 26 : 30;
  return `${normalizedShop}|${normalizedName.slice(0, prefixLength)}`;
}

function makeReason(item) {
  const parts = [];
  if (item.reviewAverage >= config.rakuten.minReviewAverage) parts.push(`平均評価 ${item.reviewAverage.toFixed(1)}`);
  if (item.reviewCount >= config.rakuten.minReviewCount) parts.push(`レビュー ${item.reviewCount.toLocaleString("ja-JP")} 件`);
  if (item.price > 0) parts.push(`価格目安 ${formatPrice(item.price)}`);
  return parts.length ? parts.join(" / ") : "比較候補として掲載";
}

function getSeason(date) {
  const month = date.getMonth() + 1;
  return config.seasonalCalendar.find((entry) => entry.months.includes(month)) || config.seasonalCalendar[0];
}

function getEventMonthDistance(event, date) {
  const month = date.getMonth() + 1;
  return (event.month - month + 12) % 12;
}

function getUpcomingSeasonalEvents(date, limit = 6) {
  return [...config.seasonalEvents]
    .sort((a, b) => {
      const distanceA = getEventMonthDistance(a, date);
      const distanceB = getEventMonthDistance(b, date);
      if (distanceA !== distanceB) return distanceA - distanceB;
      return config.seasonalEvents.indexOf(a) - config.seasonalEvents.indexOf(b);
    })
    .slice(0, limit);
}

function getSeasonalEventVisual(event) {
  const text = `${event.title} ${event.description} ${(event.keywords || []).join(" ")}`;
  if (/お中元|夏ギフト|アイス/.test(text)) return "assets/event-summer-gift.svg";
  if (/父の日/.test(text)) return "assets/event-fathers-day.svg";
  if (/防災|備蓄|非常食|新学期/.test(text)) return "assets/event-disaster.svg";
  if (/海の日|夏休み|炭酸水|冷感/.test(text)) return "assets/event-ocean-summer.svg";
  if (/土用の丑の日|うなぎ|スタミナ/.test(text)) return "assets/event-eel.svg";
  if (/お盆|帰省|手土産/.test(text)) return "assets/event-obon.svg";
  if (/入学|新生活|卒業|送別|成人|受験/.test(text)) return "assets/event-school.svg";
  if (/母の日|ひな祭り|ホワイトデー|花|こどもの日/.test(text)) return "assets/event-spring.svg";
  if (/梅雨|花粉|除湿|カビ|加湿|体調/.test(text)) return "assets/event-rainy.svg";
  if (/敬老の日|秋分|衣替え|七五三|文化の日|ハロウィン|行楽|スポーツ/.test(text)) return "assets/event-autumn.svg";
  if (/ブラックフライデー|初売り|福袋|セール/.test(text)) return "assets/event-sale.svg";
  if (/クリスマス|お歳暮|大掃除|冬支度|年末ギフト/.test(text)) return "assets/event-winter.svg";
  return "assets/season-cycle.svg";
}

function getEventsByMonth() {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    return {
      month,
      events: config.seasonalEvents.filter((event) => event.month === month)
    };
  });
}

function getTopicTopItem(topicResults, topic) {
  return topicResults[topic.slug]?.items?.[0] || null;
}

function getValueLine(item) {
  if (!item) return "価格・レビューを見て比較";
  const parts = [];
  if (item.price > 0) parts.push(formatPrice(item.price));
  if (item.reviewAverage > 0) parts.push(`平均${item.reviewAverage.toFixed(1)}`);
  if (item.reviewCount > 0) parts.push(`${item.reviewCount.toLocaleString("ja-JP")}件`);
  return parts.join(" / ") || item.reason;
}

function makeMiniReason(topic, item) {
  if (!item) return topic.angle;
  const title = shortTitle(topic.title);
  if (item.reviewCount >= 1000) return `${title}の中でもレビュー数が多く、条件を比べやすい候補です。`;
  if (item.reviewAverage >= 4.4) return `${title}の中でも平均評価が高めで、比較候補に入れやすい商品です。`;
  return `${title}の比較候補です。容量、価格、レビューを見てから選べます。`;
}

function getTopicAliases(topic) {
  const aliases = {
    "drink-stock": "ポカリ ポカリスエット スポーツドリンク スポドリ アクエリアス イオンウォーター OS1 経口補水液 水分補給 熱中症対策 サイダー ソーダ ラムネ 炭酸 炭酸水 炭酸飲料 コーラ スプライト 三ツ矢 ジンジャーエール ミネラルウォーター 天然水 ペットボトル 麦茶 緑茶 烏龍茶 ウーロン茶 おちゃ お茶 ドリンク 飲料 ケース買い 箱買い",
    "rice-pantry": "こめ お米 米 ごはん ご飯 ライス 白米 玄米 無洗米 雑穀米 パックご飯 パックごはん レンチン レトルト 常温保存 非常食 保存食 備蓄 防災 ローリングストック 主食",
    "seasonal-gifts": "ギフト プレゼント 贈答 贈り物 お礼 お返し 手土産 差し入れ お中元 御中元 お歳暮 御歳暮 父の日 母の日 敬老の日 誕生日 内祝い うなぎ アイス コーヒー スイーツ",
    "daily-essentials": "日用品 消耗品 生活用品 洗剤 柔軟剤 詰め替え つめかえ 大容量 トイレットペーパー トイレットロール ティッシュ ティッシュペーパー キッチンペーパー 紙類 ケース買い 箱買い まとめ買い",
    "cleaning-laundry": "掃除 そうじ 清掃 洗濯 ランドリー カビ カビ取り 除湿 湿気 梅雨 洗剤 漂白 消臭 部屋干し 浴室 風呂 洗濯槽 クリーナー",
    "kitchen-storage": "保存容器 タッパー フードコンテナ 作り置き 冷蔵庫 収納 キッチン収納 ラック 棚 整理 整頓 片付け 小物入れ 食品ストック 密閉容器",
    "small-appliances": "家電 小型家電 時短家電 キッチン家電 ケトル 電気ケトル 扇風機 サーキュレーター 送風 部屋干し ハンディファン 卓上ファン 省スペース 時短",
    "bath-sleep": "タオル バスタオル フェイスタオル 寝具 枕 まくら 布団 ふとん 敷きパッド 冷感 夏用 バス用品 お風呂 風呂 リラックス くつろぎ 快眠",
    "emergency-stock": "防災 備蓄 非常食 保存食 備蓄水 水 ランタン ライト 懐中電灯 ラジオ 防災リュック 防災セット 停電 災害 ローリングストック",
    "summer-cooling": "暑さ対策 熱中症対策 冷感 日傘 晴雨兼用 ネッククーラー 冷却プレート 冷感タオル ハンディファン 扇風機 外出 通勤 夏",
    "hygiene-care": "衛生用品 マスク 不織布マスク ハンドソープ 除菌シート ウェットティッシュ 消毒 詰め替え まとめ買い 日用品 身だしなみ",
    "baby-care": "ベビー用品 育児用品 赤ちゃん用品 おむつ オムツ おしめ パンツタイプ テープタイプ おしりふき お尻拭き ベビーワイプ 粉ミルク 液体ミルク ベビーフード 離乳食 哺乳瓶 ベビーソープ ベビーローション まとめ買い ケース買い 出産準備 子育て"
  };
  return aliases[topic.slug] || "";
}

function getCategoryDescription(topic) {
  const description = config.categoryDescriptions?.[topic.slug] || {};
  return {
    title: description.title || `${shortTitle(topic.title)}の解説`,
    paragraphs: Array.isArray(description.paragraphs) ? description.paragraphs.filter(Boolean) : [],
    points: Array.isArray(description.points) ? description.points.filter(Boolean) : []
  };
}

function buildSearchText(...parts) {
  return parts
    .flat()
    .map((part) => truncate(stripHtml(String(part || "")), 180))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function getBaseUrl() {
  return config.baseUrl.replace(/\/$/, "");
}

function pageUrl(page = "index.html") {
  const baseUrl = getBaseUrl();
  return page === "index.html" ? `${baseUrl}/` : `${baseUrl}/${page}`;
}

function getTopicSearchTerms(topic) {
  const terms = buildSearchText(topic.keyword, getTopicAliases(topic))
    .split(/\s+/)
    .filter(Boolean);
  return Array.from(new Set(terms)).slice(0, 14);
}

function getTopicGuide(topic) {
  const guides = {
    "drink-stock": {
      lead: "飲料のまとめ買いは、1本あたりの価格だけでなく、置き場所、飲み切れる本数、ラベルの捨てやすさまで見ると選びやすくなります。",
      checks: ["500mlか2Lかを先に決める", "ラベルレスやケースサイズを確認する", "炭酸水は割り材用かそのまま飲む用かで選ぶ", "夏場はスポーツドリンクやお茶も候補に入れる"]
    },
    "rice-pantry": {
      lead: "主食や保存食は、安さだけでなく、保管しやすさ、賞味期限、普段の食事で消費できるかを見ておくと無駄が出にくくなります。",
      checks: ["米は5kg袋か10kg袋かを置き場所で選ぶ", "パックご飯は食数と賞味期限を見る", "非常食は普段食べられる味を選ぶ", "水や日用品と一緒に備蓄量を見直す"]
    },
    "seasonal-gifts": {
      lead: "ギフトは価格よりも、贈る相手、配送日、のし対応、レビューの安定感が大事です。季節イベント前は早めに候補を絞ると選びやすくなります。",
      checks: ["配送日指定やのし対応を確認する", "冷凍・冷蔵品は受け取りやすさを見る", "レビュー件数が多い定番品を優先する", "家族向けか職場向けかで量を決める"]
    },
    "daily-essentials": {
      lead: "日用品はまとめ買いしやすい一方で、置き場所を圧迫しがちです。単価、容量、保管スペースを一緒に見ると失敗しにくくなります。",
      checks: ["月に使う量から買い過ぎを防ぐ", "詰め替え用は本体対応を確認する", "紙類はケースサイズを見る", "重いものは送料込みか確認する"]
    },
    "cleaning-laundry": {
      lead: "掃除・洗濯用品は、使う場所や素材との相性が重要です。まとめ買い前に、対応素材、香り、保管しやすさを確認してください。",
      checks: ["カビ取り剤は使える素材を確認する", "洗剤は香りや液性を見る", "除湿剤は置く場所の数で選ぶ", "洗濯槽クリーナーはドラム式対応を確認する"]
    },
    "kitchen-storage": {
      lead: "キッチン収納は、見た目よりもサイズと使う頻度が大事です。冷蔵庫や棚の寸法に合うかを先に確認すると選びやすくなります。",
      checks: ["置き場所の幅・奥行き・高さを測る", "保存容器は電子レンジ対応を確認する", "重ねやすさと洗いやすさを見る", "食品ストックは中身が見えるものを選ぶ"]
    },
    "small-appliances": {
      lead: "小型家電は、価格だけでなく、音、サイズ、手入れのしやすさ、消費電力も比較すると日常使いしやすいものを選べます。",
      checks: ["置き場所とコードの長さを見る", "音量や風量のレビューを確認する", "洗える部品があるか見る", "保証や返品条件を販売ページで確認する"]
    },
    "bath-sleep": {
      lead: "タオルや寝具は肌に触れる時間が長いので、素材、洗濯しやすさ、乾きやすさ、サイズ感を見て選ぶと満足度が上がりやすいです。",
      checks: ["洗濯頻度に合わせて枚数を決める", "寝具はサイズと固定方法を見る", "冷感素材はレビューの体感差も確認する", "枕は高さ調整や返品条件を見る"]
    },
    "emergency-stock": {
      lead: "防災用品は一度に全部そろえるより、水、食料、明かり、情報手段を分けて見直すと抜け漏れを減らせます。",
      checks: ["人数と日数に合う量を選ぶ", "賞味期限や交換時期を確認する", "ライトやランタンは充電方法を見る", "普段の置き場所と重さを確認する"]
    },
    "summer-cooling": {
      lead: "暑さ対策用品は、外出用か室内用かで選び方が変わります。重さ、連続使用時間、持ち運びやすさを比べてください。",
      checks: ["通勤用は軽さと収納性を見る", "冷却グッズは連続使用時間を確認する", "日傘は遮光率とサイズを見る", "家族用は複数枚セットも候補にする"]
    },
    "hygiene-care": {
      lead: "衛生用品は毎日使うものが多いため、価格だけでなく、容量、肌あたり、保管しやすさを見て補充すると続けやすくなります。",
      checks: ["マスクはサイズと枚数を見る", "ハンドソープは詰め替え対応を確認する", "除菌シートは枚数と乾きにくさを見る", "まとめ買いは置き場所を先に決める"]
    },
    "baby-care": {
      lead: "ベビー用品は切らすと困るものが多いため、サイズ、月齢、肌あたり、消費ペース、保管場所を先に見ておくと買い足しが楽になります。",
      checks: ["おむつはサイズとタイプを先に確認する", "おしりふきは厚みと枚数、乾きにくさを見る", "ミルクや離乳食は月齢と賞味期限を確認する", "まとめ買いは置き場所と配送条件も見る"]
    }
  };
  return guides[topic.slug] || {
    lead: topic.angle,
    checks: ["価格を確認する", "レビュー件数を見る", "送料やポイント条件を見る", "販売ページで最新情報を確認する"]
  };
}

function getTopicFaq(topic) {
  const title = shortTitle(topic.title);
  return [
    {
      question: `${title}は何を基準に比べると選びやすいですか？`,
      answer: `まず価格、レビュー件数、平均評価を見て候補を絞り、最後に送料、在庫、クーポン、ポイント条件を楽天の販売ページで確認してください。`
    },
    {
      question: `安い商品を選べば十分ですか？`,
      answer: `安さだけで決めると、容量やサイズ、保管しやすさが合わないことがあります。価格目安とレビューの量、日常で使い切れるかを一緒に見るのがおすすめです。`
    },
    {
      question: `このページの商品リンクは広告ですか？`,
      answer: `はい。商品リンク経由で購入や申込が発生すると、運営者が紹介料を受け取る場合があります。掲載順位は価格、レビュー、季節性、比較しやすさをもとに整理しています。`
    }
  ];
}

function buildComparisonTable(items) {
  const rows = items.slice(0, 6).map((item, index) => {
    const href = item.url || item.fallbackUrl;
    const label = truncate(item.name, 64);
    return `
      <tr>
        <td><span>${index + 1}</span>${escapeHtml(truncate(item.name, 46))}</td>
        <td>${escapeHtml(formatPrice(item.price))}</td>
        <td>${item.reviewAverage ? item.reviewAverage.toFixed(1) : "-"}</td>
        <td>${item.reviewCount.toLocaleString("ja-JP")}件</td>
        <td><a href="${escapeAttribute(href)}" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(label)}" data-click-area="comparison">楽天で見る</a></td>
      </tr>`;
  }).join("");

  return `
    <div class="compare-table-wrap">
      <table class="compare-table">
        <thead>
          <tr>
            <th>候補</th>
            <th>価格目安</th>
            <th>平均</th>
            <th>レビュー</th>
            <th>確認</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function buildTopicJsonLd(topic, items) {
  const page = `${topic.slug}.html`;
  const products = items
    .slice(0, 12)
    .map((item, index) => buildProductJsonLd(topic, item, page, index))
    .filter(Boolean);
  return [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      "itemListElement": [
        {
          "@type": "ListItem",
          "position": 1,
          "name": config.siteName,
          "item": pageUrl("index.html")
        },
        {
          "@type": "ListItem",
          "position": 2,
          "name": topic.title,
          "item": pageUrl(page)
        }
      ]
    },
    {
      "@context": "https://schema.org",
      "@type": "ItemList",
      "name": `${topic.title}の比較候補`,
      "itemListElement": items.slice(0, 10).map((item, index) => ({
        "@type": "ListItem",
        "position": index + 1,
        "name": item.name,
        "url": item.url || item.fallbackUrl
      }))
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": getTopicFaq(topic).map((faq) => ({
        "@type": "Question",
        "name": faq.question,
        "acceptedAnswer": {
          "@type": "Answer",
          "text": faq.answer
        }
      }))
    }
  ].concat(products);
}

function buildProductJsonLd(topic, item, page, index) {
  if (!item?.name) return null;
  const product = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${pageUrl(page)}#product-${index + 1}`,
    "name": item.name,
    "url": item.url || item.directUrl || item.fallbackUrl,
    "category": topic.title
  };

  if (item.caption) {
    product.description = truncate(item.caption, 220);
  }

  if (isHttpUrl(item.imageUrl)) {
    product.image = [item.imageUrl];
  }

  if (item.price > 0) {
    product.offers = {
      "@type": "Offer",
      "url": item.url || item.directUrl || item.fallbackUrl,
      "priceCurrency": "JPY",
      "price": String(item.price)
    };
  }

  if (item.reviewAverage > 0 && item.reviewCount > 0) {
    product.aggregateRating = {
      "@type": "AggregateRating",
      "ratingValue": Number(item.reviewAverage.toFixed(1)),
      "reviewCount": item.reviewCount
    };
  }

  return product;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

async function writeHomePage(topicResults, dataMode) {
  const highlightItems = config.topics.slice(0, 6).map((topic, index) => {
    const top = getTopicTopItem(topicResults, topic);
    if (!top) return "";
    return `
      <article class="rank-card ${escapeAttribute(topic.accent || "")}" data-search="${escapeAttribute(buildSearchText(topic.title, topic.keyword, getTopicAliases(topic), top.name, top.caption))}">
        <a href="${topic.slug}.html">
          <span class="rank-number">${index + 1}</span>
          <img src="${escapeAttribute(top.imageUrl)}" alt="${escapeAttribute(top.name)}" loading="lazy">
          <div>
            <small>${escapeHtml(shortTitle(topic.title))}</small>
            <h3>${escapeHtml(top.name)}</h3>
            <p>${escapeHtml(getValueLine(top))}</p>
            <strong>候補を見る</strong>
          </div>
        </a>
      </article>`;
  }).join("");

  const topicCards = config.topics.map((topic, index) => {
    const topicResult = topicResults[topic.slug];
    const top = getTopicTopItem(topicResults, topic);
    const visual = top?.imageUrl || `assets/${topic.slug}.svg`;
    return `
      <article class="topic-card ${escapeAttribute(topic.accent || "")}" data-search="${escapeAttribute(buildSearchText(topic.title, topic.keyword, topic.angle, getTopicAliases(topic), top?.name || ""))}">
        <a href="${topic.slug}.html" class="topic-link">
          <img class="topic-visual" src="${escapeAttribute(visual)}" alt="${escapeAttribute(top?.name || topic.title)}" loading="lazy">
          <span class="topic-kicker">${String(index + 1).padStart(2, "0")} / ${escapeHtml(topic.keyword)}</span>
          <h2>${escapeHtml(topic.title)}</h2>
          <p>${escapeHtml(topic.angle)}</p>
          ${top ? `<div class="topic-stats"><span>${escapeHtml(formatPrice(top.price))}</span><span>平均 ${top.reviewAverage ? top.reviewAverage.toFixed(1) : "-"}</span><span>${top.reviewCount.toLocaleString("ja-JP")}件</span></div>` : ""}
          <span class="topic-source ${topicResult?.source === "live" ? "live" : "sample"}">${topicResult?.source === "live" ? "実データ" : "サンプル表示"}</span>
          ${top ? `<strong>注目候補: ${escapeHtml(top.name)}</strong>` : ""}
          <span class="topic-cta">比較ページへ</span>
        </a>
      </article>`;
  }).join("");

  const buyerPathCards = [
    {
      label: "定番化",
      title: "重いもの・かさばるものは先に定番を決める",
      text: "水、米、洗剤、トイレットペーパーは消費ペースが読めるので、一度「これでいい」という定番を決めておくと、毎回比較する手間が消えます。価格とレビューの変化だけ時々チェックすれば十分です。",
      visual: "assets/drink-stock.svg"
    },
    {
      label: "季節",
      title: "イベント・季節ものは時期の前に絞る",
      text: "お中元、父の日、敬老の日などは直前ほど選択肢が減り、価格も上がります。早割や配送枠があるうちに、レビュー数の多い候補から絞っておくと、安く・確実に・迷わず買えます。",
      visual: "assets/seasonal-gifts.svg"
    },
    {
      label: "収納",
      title: "収納・家電はサイズと置き場所を先に見る",
      text: "収納用品や小型家電は、商品の良し悪しより「置き場所に合うか」が重要です。買う前に寸法を測り、手入れのしやすさ（洗えるか、パーツが外れるか）もレビューで確認すると失敗しません。",
      visual: "assets/kitchen-storage.svg"
    },
    {
      label: "単価",
      title: "まとめ買いは「1個あたりの単価」で判断する",
      text: "総額が安く見えても、1個（1回分・1本）あたりに直すと割高なことがあります。総額 ÷ 個数で単価を出し、置ける量と合わせて判断するのが鉄則です。",
      visual: "assets/daily-essentials.svg"
    },
    {
      label: "肌あたり",
      title: "子ども・肌に触れるものは少量から試す",
      text: "おむつ、衣類、肌に使うものは、体格や肌質で合う合わないがあります。いきなりまとめ買いせず、合うと分かってから大容量に切り替えると無駄が出ません。",
      visual: "assets/baby-care.svg"
    },
    {
      label: "備蓄",
      title: "防災・備蓄は日常の延長で回す",
      text: "非常食や備蓄水は、専用品を別に持つより、普段使う食品を少し多めに買って古いものから消費する「ローリングストック」が続けやすく、賞味期限切れも防げます。",
      visual: "assets/emergency-stock.svg"
    }
  ].map((card, index) => `
    <article>
      <img src="${escapeAttribute(card.visual)}" alt="" loading="lazy">
      <span>${escapeHtml(card.label)}</span>
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.text)}</p>
    </article>
  `).join("");

  const heroGallery = config.topics.slice(0, 5).map((topic) => {
    const top = getTopicTopItem(topicResults, topic);
    const visual = top?.imageUrl || `assets/${topic.slug}.svg`;
    return `
      <a href="${topic.slug}.html" data-search="${escapeAttribute(buildSearchText(topic.title, topic.keyword, getTopicAliases(topic), top?.name || ""))}">
        <img src="${escapeAttribute(visual)}" alt="${escapeAttribute(top?.name || topic.title)}" loading="lazy">
        <span>${escapeHtml(shortTitle(topic.title))}</span>
      </a>`;
  }).join("");

  const seasonalFeatureCards = getUpcomingSeasonalEvents(now, 6).map((entry) => {
    const visual = getSeasonalEventVisual(entry);
    const keywords = entry.keywords.slice(0, 4).map((keyword) => `
      <a href="https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(keyword)}" data-click-area="seasonal-card">${escapeHtml(keyword)}</a>
    `).join("");
    return `
      <article class="season-card">
        <img src="${escapeAttribute(visual)}" alt="" loading="lazy">
        <span>${entry.dateLabel}</span>
        <h3>${escapeHtml(entry.title)}</h3>
        <p>${escapeHtml(entry.description)}</p>
        <div class="season-card-links">${keywords}</div>
      </article>`;
  }).join("");

  const statusText = dataMode === "live"
    ? "Rakuten API"
    : dataMode === "mixed"
      ? "一部Rakuten API"
      : "サンプル";

  const statusNote = dataMode === "live"
    ? "全テーマで実データを表示中"
    : dataMode === "mixed"
      ? "一部テーマはサンプルを表示中"
      : "楽天取得失敗時はサンプルでプレビューします";

  const html = layout({
    title: config.siteName,
    description: config.description,
    path: "index.html",
    showUtility: false,
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": config.siteName,
        "url": pageUrl("index.html"),
        "description": config.description,
        "mainEntity": {
          "@type": "ItemList",
          "itemListElement": config.topics.map((topic, index) => ({
            "@type": "ListItem",
            "position": index + 1,
            "name": topic.title,
            "url": pageUrl(`${topic.slug}.html`)
          }))
        }
      }
    ],
    body: `
      <section class="hero">
        <div class="hero-copy">
          <p class="eyebrow">${escapeHtml(season.label)}</p>
          <h1>${escapeHtml(config.siteName)}</h1>
          <p>楽天で買う前に、日用品・食品・収納・掃除・季節ギフトなどの候補を価格目安、レビュー件数、平均評価から整理する買い物メモです。迷ったら、まず比較しやすい候補から見ていけます。</p>
          <div class="hero-actions">
            <a class="primary-action" href="#today-pickup">今日の候補を見る</a>
            <a class="secondary-action" href="#shopping-themes">カテゴリから探す</a>
          </div>
          <div class="season-tags" aria-label="季節の注目キーワード">
            ${season.keywords.map((keyword) => `<span>${escapeHtml(keyword)}</span>`).join("")}
          </div>
          <div class="hero-info-row" aria-label="サイトの更新情報">
            <span><strong>${config.topics.length}</strong>カテゴリ</span>
            <span><strong>${liveTopicCount}</strong>カテゴリ更新</span>
            <span><strong>毎日</strong>自動更新</span>
          </div>
          <div class="hero-gallery" aria-label="注目カテゴリ">
            ${heroGallery}
          </div>
        </div>
        <aside class="status-panel">
          <span>最終更新</span>
          <strong>${formatDate(now)}</strong>
          <small class="data-source">データ: ${statusText}</small>
          <small>${statusNote}</small>
        </aside>
      </section>
      <div class="home-utility">
        ${utilityBlock()}
      </div>
      <section id="today-pickup" class="section-heading">
        <div>
          <p class="eyebrow">TODAY'S PICKUP</p>
          <h2>今日のおすすめ</h2>
          <p>下のリンクから楽天の商品ページへ進めます。</p>
        </div>
      </section>
      <section class="rank-grid" aria-label="今日の候補">
        ${highlightItems}
      </section>
      <section class="season-lane" aria-label="季節の買い物メモ">
        <div class="season-main">
          <img src="assets/season-cycle.svg" alt="" loading="lazy">
          <p class="eyebrow">SEASONAL NOTE</p>
          <h2>今から見たい季節イベント</h2>
          <p>祝日、学校行事、ギフト、天候、セール時期に合わせて、早めに見ておきたい買い物候補をまとめます。</p>
          <div class="season-keywords">
            ${season.keywords.map((keyword) => `<a href="https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(keyword)}" data-click-area="seasonal-note">${escapeHtml(keyword)}</a>`).join("")}
          </div>
          <a class="season-calendar-link" href="seasonal-calendar.html">年間イベントを全部見る</a>
        </div>
        <div class="season-card-grid">${seasonalFeatureCards}</div>
      </section>
      <section class="section-heading">
        <div>
          <p class="eyebrow">SHOPPING THEMES</p>
          <h2>暮らしのカテゴリ</h2>
          <p>水、米、日用品、収納、掃除、家電、ギフトまで、買いたい目的に合わせて探せます。</p>
        </div>
      </section>
      <section class="topics-grid" aria-label="買い物テーマ">
        ${topicCards}
      </section>
      <section class="section-heading">
        <div>
          <p class="eyebrow">BUYER PATH</p>
          <h2>迷った時の選び方</h2>
          <p>似た商品が多い時は、先に買う目的を決めてから価格、レビュー、容量、置き場所の順に見ていくと選びやすくなります。</p>
        </div>
      </section>
      <section class="buyer-path" aria-label="買い物の見方">
        ${buyerPathCards}
      </section>
      <section class="content-with-rail">
        <div class="plain-section">
          <h2>掲載の考え方</h2>
          <p>このサイトは、日用品や食品などの買い物候補を整理するためのメモです。掲載文では、価格、レビュー、季節性、比較しやすさを優先します。</p>
        </div>
        <aside class="ad-slot" aria-label="関連特集">
          <span>関連特集</span>
          <strong>季節ごとの買い物候補を追加予定</strong>
        </aside>
      </section>`
  });

  await writeFile(path.join(outDir, "index.html"), html);
}

async function writeRankingPage(topicResults, dataMode) {
  const allRankedItems = config.topics
    .flatMap((topic) => (topicResults[topic.slug]?.items || []).map((item) => ({ topic, item })))
    .sort((a, b) => b.item.score - a.item.score);
  const requiredCategoryItems = config.topics
    .map((topic) => {
      const item = topicResults[topic.slug]?.items?.[0];
      return item ? { topic, item } : null;
    })
    .filter(Boolean);
  const seenRankingKeys = new Set();
  const rankedItems = [...requiredCategoryItems, ...allRankedItems]
    .filter(({ item }) => {
      const key = item.url || item.directUrl || item.name;
      if (seenRankingKeys.has(key)) return false;
      seenRankingKeys.add(key);
      return true;
    })
    .slice(0, 30);

  const featured = rankedItems.slice(0, 3).map(({ topic, item }, index) => {
    const href = item.url || item.fallbackUrl;
    return `
      <article class="ranking-feature ${escapeAttribute(topic.accent || "")}" data-search="${escapeAttribute(buildSearchText(topic.title, topic.keyword, getTopicAliases(topic), item.name, item.caption))}">
        <a href="${escapeAttribute(href)}" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(item.name)}" data-click-area="ranking-feature">
          <span>${index + 1}</span>
          <img src="${escapeAttribute(item.imageUrl)}" alt="${escapeAttribute(item.name)}" loading="lazy">
          <div>
            <small>${escapeHtml(shortTitle(topic.title))}</small>
            <h2>${escapeHtml(item.name)}</h2>
            <p>${escapeHtml(getValueLine(item))}</p>
            <strong>楽天で価格・在庫を見る</strong>
          </div>
        </a>
      </article>`;
  }).join("");

  const rows = rankedItems.map(({ topic, item }, index) => {
    const href = item.url || item.fallbackUrl;
    return `
      <tr data-search="${escapeAttribute(buildSearchText(topic.title, topic.keyword, getTopicAliases(topic), item.name, item.caption))}">
        <td><span>${index + 1}</span>${escapeHtml(item.name)}</td>
        <td>${escapeHtml(shortTitle(topic.title))}</td>
        <td>${formatPrice(item.price)}</td>
        <td>${item.reviewAverage ? item.reviewAverage.toFixed(1) : "-"}</td>
        <td>${item.reviewCount.toLocaleString("ja-JP")}件</td>
        <td><a href="${escapeAttribute(href)}" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(item.name)}" data-click-area="ranking-table">楽天で見る</a></td>
      </tr>`;
  }).join("");

  const html = layout({
    title: `横断ランキング - ${config.siteName}`,
    description: "暮らしの買い物候補をカテゴリ横断で並べ、価格目安、レビュー件数、平均評価から比較できるページです。",
    path: "ranking.html",
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "横断ランキング",
        "url": pageUrl("ranking.html"),
        "description": "暮らしの買い物候補をカテゴリ横断で比較します。",
        "mainEntity": {
          "@type": "ItemList",
          "itemListElement": rankedItems.map(({ item }, index) => ({
            "@type": "ListItem",
            "position": index + 1,
            "name": item.name,
            "url": item.url || item.fallbackUrl
          }))
        }
      }
    ],
    body: `
      <section class="topic-hero ranking-hero">
        <p class="eyebrow">CROSS CATEGORY RANKING</p>
        <h1>暮らしの買い物候補ランキング</h1>
        <p>各カテゴリの商品を横断して、レビュー件数、平均評価、価格目安、比較しやすさから並べています。気になる候補は楽天の商品ページで在庫、送料、ポイント条件を確認してください。</p>
        <div class="source-banner">${dataMode === "live" ? "楽天APIの公開データをもとに更新しています。" : "一部サンプル表示を含みます。"}</div>
      </section>
      <section class="ranking-feature-grid" aria-label="上位候補">
        ${featured}
      </section>
      <section class="section-heading">
        <div>
          <p class="eyebrow">COMPARE</p>
          <h2>価格とレビューを横断比較</h2>
          <p>カテゴリをまたいで見比べたいときの一覧です。購入前の最終条件は楽天の商品ページで確認してください。</p>
        </div>
      </section>
      <div class="compare-table-wrap">
        <table class="compare-table ranking-table">
          <thead>
            <tr>
              <th>候補</th>
              <th>カテゴリ</th>
              <th>価格目安</th>
              <th>平均評価</th>
              <th>レビュー</th>
              <th>販売ページ</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>`
  });

  await writeFile(path.join(outDir, "ranking.html"), html);
}

async function writeIntentPage(topicResults, dataMode) {
  const groups = [
    {
      label: "今日すぐ見たい",
      title: "暑さ・水分補給・季節ギフト",
      text: "時期の影響を受けやすい候補を先に並べています。",
      slugs: ["drink-stock", "summer-cooling", "seasonal-gifts"]
    },
    {
      label: "切らすと困る",
      title: "食品・日用品・防災ストック",
      text: "まとめ買いしやすく、残量管理に向いている候補です。",
      slugs: ["rice-pantry", "daily-essentials", "emergency-stock", "baby-care"]
    },
    {
      label: "家事を軽くする",
      title: "掃除・洗濯・キッチン収納",
      text: "作業時間や片付けやすさに関わる候補を集めています。",
      slugs: ["cleaning-laundry", "kitchen-storage", "small-appliances"]
    },
    {
      label: "毎日の快適さ",
      title: "バス・睡眠・衛生用品",
      text: "日常で使う頻度が高く、レビュー差を見たい候補です。",
      slugs: ["bath-sleep", "hygiene-care"]
    }
  ];

  const sections = groups.map((group) => {
    const cards = group.slugs.map((slug) => {
      const topic = config.topics.find((entry) => entry.slug === slug);
      const item = topic ? getTopicTopItem(topicResults, topic) : null;
      if (!topic || !item) return "";
      const href = item.url || item.fallbackUrl;
      return `
        <article class="intent-card ${escapeAttribute(topic.accent || "")}" data-search="${escapeAttribute(buildSearchText(group.title, group.text, topic.title, topic.keyword, getTopicAliases(topic), item.name, item.caption))}">
          <img src="${escapeAttribute(item.imageUrl)}" alt="${escapeAttribute(item.name)}" loading="lazy">
          <div>
            <span>${escapeHtml(shortTitle(topic.title))}</span>
            <h3>${escapeHtml(item.name)}</h3>
            <p>${escapeHtml(getValueLine(item))}</p>
            <div class="intent-actions">
              <a href="${topic.slug}.html">比較を見る</a>
              <a href="${escapeAttribute(href)}" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(item.name)}" data-click-area="intent-card">楽天で見る</a>
            </div>
          </div>
        </article>`;
    }).join("");

    return `
      <section class="intent-group">
        <div class="section-heading compact-heading">
          <div>
            <p class="eyebrow">${escapeHtml(group.label)}</p>
            <h2>${escapeHtml(group.title)}</h2>
            <p>${escapeHtml(group.text)}</p>
          </div>
        </div>
        <div class="intent-grid">
          ${cards}
        </div>
      </section>`;
  }).join("");

  const html = layout({
    title: `目的別に探す - ${config.siteName}`,
    description: "暮らしの買い物候補を、今日見たいもの、ストック、家事、快適さなどの目的別に整理したページです。",
    path: "shopping-intents.html",
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "目的別に探す",
        "url": pageUrl("shopping-intents.html"),
        "description": "暮らしの買い物候補を目的別に整理します。"
      }
    ],
    body: `
      <section class="topic-hero intent-hero">
        <p class="eyebrow">SHOP BY PURPOSE</p>
        <h1>目的別に買い物候補を探す</h1>
        <p>商品名が決まっていなくても、使う場面から候補に進めるページです。比較ページで価格とレビューを見て、最後は楽天の商品ページで条件を確認してください。</p>
        <div class="source-banner">${dataMode === "live" ? "楽天APIの公開データをもとに更新しています。" : "一部サンプル表示を含みます。"}</div>
      </section>
      ${sections}`
  });

  await writeFile(path.join(outDir, "shopping-intents.html"), html);
}

async function writeGuidesPage(topicResults, dataMode) {
  const cards = config.topics.map((topic) => {
    const guide = getTopicGuide(topic);
    const item = getTopicTopItem(topicResults, topic);
    const visual = item?.imageUrl || `assets/${topic.slug}.svg`;
    const checks = guide.checks.slice(0, 4).map((check) => `<li>${escapeHtml(check)}</li>`).join("");
    return `
      <article class="guide-card ${escapeAttribute(topic.accent || "")}" data-search="${escapeAttribute(buildSearchText(topic.title, topic.keyword, topic.angle, getTopicAliases(topic), guide.lead, guide.checks, item?.name || ""))}">
        <img src="${escapeAttribute(visual)}" alt="${escapeAttribute(item?.name || topic.title)}" loading="lazy">
        <div>
          <span>${escapeHtml(shortTitle(topic.title))}</span>
          <h2>${escapeHtml(topic.title)}</h2>
          <p>${escapeHtml(guide.lead)}</p>
          <ul>${checks}</ul>
          <a href="${topic.slug}.html">比較ページを見る</a>
        </div>
      </article>`;
  }).join("");

  const html = layout({
    title: `買う前の選び方ガイド - ${config.siteName}`,
    description: "暮らしの道具や日用品を買う前に確認したい、価格、レビュー、容量、保管、季節性などのチェックポイントをまとめたページです。",
    path: "guides.html",
    structuredData: [
      {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        "name": "買う前の選び方ガイド",
        "url": pageUrl("guides.html"),
        "description": "暮らしの買い物候補を選ぶ前のチェックポイント集です。"
      }
    ],
    body: `
      <section class="topic-hero guide-hero">
        <p class="eyebrow">BUYING GUIDES</p>
        <h1>買う前の選び方ガイド</h1>
        <p>価格だけで決めにくい日用品や暮らしの道具を、容量、レビュー、置き場所、季節性、販売ページでの確認点に分けて整理しています。</p>
        <div class="source-banner">${dataMode === "live" ? "楽天APIの商品情報とカテゴリ別の確認点をもとに整理しています。" : "一部サンプル表示を含みます。"}</div>
      </section>
      <section class="guide-list" aria-label="買う前の確認点">
        ${cards}
      </section>`
  });

  await writeFile(path.join(outDir, "guides.html"), html);
}

async function writeTopicPage(topic, items, source) {
  const topItem = items[0];
  const railLink = topItem?.url || topItem?.fallbackUrl || "";
  const guide = getTopicGuide(topic);
  const faqs = getTopicFaq(topic);
  const searchTerms = getTopicSearchTerms(topic);
  const categoryDescription = getCategoryDescription(topic);
  const comparison = buildComparisonTable(items);
  const priorityItems = items.slice(0, 3).map((item, index) => {
    const href = item.url || item.fallbackUrl;
    return `
      <article class="priority-card" data-search="${escapeAttribute(buildSearchText(topic.title, topic.keyword, getTopicAliases(topic), item.name, item.caption))}">
        <span>${index + 1}</span>
        ${item.imageUrl ? `<img src="${escapeAttribute(item.imageUrl)}" alt="${escapeAttribute(item.name)}" loading="lazy">` : ""}
        <div>
          <small>${index === 0 ? "まず見る候補" : index === 1 ? "比較候補" : "予備候補"}</small>
          <h3>${escapeHtml(item.name)}</h3>
          <p>${escapeHtml(getValueLine(item))}</p>
          <a href="${escapeAttribute(href)}" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(item.name)}" data-click-area="priority-card">楽天で確認</a>
        </div>
      </article>`;
  }).join("");
  const cards = items.map((item, index) => `
    <article class="product-card" data-search="${escapeAttribute(buildSearchText(topic.title, topic.keyword, getTopicAliases(topic), item.name, item.caption))}">
      <span class="product-rank">候補 ${index + 1}</span>
      ${item.imageUrl ? `<img src="${escapeAttribute(item.imageUrl)}" alt="${escapeAttribute(item.name)}" loading="lazy">` : ""}
      <div class="product-body">
        <div class="product-meta">
          <span>${formatPrice(item.price)}</span>
          <span>レビュー ${item.reviewCount.toLocaleString("ja-JP")}件</span>
        </div>
        <h2>${escapeHtml(item.name)}</h2>
        <div class="score-row">
          <span>平均 ${item.reviewAverage ? item.reviewAverage.toFixed(1) : "-"}</span>
          <span>${item.reviewCount.toLocaleString("ja-JP")}件</span>
          <span>${formatPrice(item.price)}</span>
        </div>
        <p class="reason">${escapeHtml(makeMiniReason(topic, item))}</p>
        ${item.caption ? `<p class="caption">${escapeHtml(truncate(item.caption, 130))}</p>` : ""}
        ${item.url
          ? `<a class="buy-link" href="${escapeAttribute(item.url)}" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(item.name)}" data-click-area="product-card">楽天で価格・在庫を見る</a>`
          : `<a class="buy-link search" href="${escapeAttribute(item.fallbackUrl)}" rel="noopener" target="_blank" data-affiliate-click="${escapeAttribute(item.name)}" data-click-area="product-search">楽天で候補を見る</a>`}
      </div>
    </article>
  `).join("");
  const categoryDescriptionSection = `
      <section class="category-description ${categoryDescription.paragraphs.length ? "has-content" : "is-empty"}" data-search="${escapeAttribute(buildSearchText(topic.title, categoryDescription.title, categoryDescription.paragraphs, categoryDescription.points))}">
        <div>
          <p class="eyebrow">CATEGORY NOTE</p>
          <h2>${escapeHtml(categoryDescription.title)}</h2>
          ${categoryDescription.paragraphs.length
            ? categoryDescription.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("")
            : `<p>このカテゴリの解説文は準備中です。文章を追加すると、ここに固定の説明として表示されます。</p>`}
        </div>
        <ul>
          ${(categoryDescription.points.length ? categoryDescription.points : ["カテゴリの特徴", "比較するときの注意点", "買う前に確認したい条件"])
            .map((point) => `<li>${escapeHtml(point)}</li>`)
            .join("")}
        </ul>
      </section>`;
  const bichikuCta = ["drink-stock", "rice-pantry", "emergency-stock", "daily-essentials"].includes(topic.slug)
    ? `
      <div class="bichiku-cta" style="margin:24px 0;padding:16px 18px;border:1px solid #ddd6c7;border-radius:12px;background:#fbf9f4">
        <p style="margin:0 0 8px;font-weight:700">わが家に必要な量は？</p>
        <p style="margin:0 0 10px;font-size:.92rem;color:#6b665c">家族の人数を入れるだけで、必要な備蓄量と買い物リストが出ます。</p>
        <a href="/bichiku/" style="color:#3f6b53;font-weight:700;text-decoration:none">→ 備蓄量をかんたん計算する</a>
      </div>`
    : "";

  const html = layout({
    title: `${topic.title} - ${config.siteName}`,
    description: topic.angle,
    path: `${topic.slug}.html`,
    structuredData: buildTopicJsonLd(topic, items),
    body: `
      <nav class="breadcrumb"><a href="index.html">トップ</a> / ${escapeHtml(topic.title)}</nav>
      <section class="page-heading topic-heading ${escapeAttribute(topic.accent || "")}">
        <img class="topic-heading-visual" src="assets/${escapeAttribute(topic.slug)}.svg" alt="${escapeAttribute(topic.title)}" loading="lazy">
        <p class="eyebrow">${escapeHtml(topic.keyword)}</p>
        <h1>${escapeHtml(topic.title)}</h1>
        <p>${escapeHtml(topic.angle)}</p>
        <div class="topic-actions">
          <a class="primary-action" href="#products">候補を比較する</a>
          <span>${source === "live" ? "楽天の商品データを表示中" : "サンプルで表示中"}</span>
        </div>
        ${source === "sample" ? `<div class="topic-alert">このテーマは現在サンプルで表示しています。実データ取得に成功すると、販売ページへのリンクと商品画像に切り替わります。</div>` : ""}
      </section>
      <section class="topic-summary" data-search="${escapeAttribute(buildSearchText(topic.title, guide.lead, guide.checks, searchTerms))}">
        <div>
          <p class="eyebrow">BUYING GUIDE</p>
          <h2>${escapeHtml(shortTitle(topic.title))}の選び方</h2>
          <p>${escapeHtml(guide.lead)}</p>
        </div>
        <ul>
          ${guide.checks.map((check) => `<li>${escapeHtml(check)}</li>`).join("")}
        </ul>
      </section>
      <section class="priority-strip" aria-label="まず見る候補">
        ${priorityItems}
      </section>
      <section class="section-heading compact-heading">
        <div>
          <p class="eyebrow">QUICK COMPARE</p>
          <h2>価格とレビューを一覧で比較</h2>
          <p>気になる候補を先に絞り、最終的な在庫、送料、ポイント条件は楽天の販売ページで確認してください。</p>
        </div>
      </section>
      ${comparison}
      ${categoryDescriptionSection}
      ${bichikuCta}
      <section class="content-with-rail">
        <div id="products" class="product-grid">
          ${cards || "<p>掲載候補がまだありません。</p>"}
        </div>
        <aside class="side-note">
          <span>比較メモ</span>
          <strong>買う前に見るポイント</strong>
          <ul>
            <li>価格は送料込みか</li>
            <li>レビュー件数が十分か</li>
            <li>ポイントやクーポン条件が合うか</li>
            <li>容量やサイズが置き場所に合うか</li>
          </ul>
          <div class="related-searches">
            <strong>関連検索</strong>
            <div>
              ${searchTerms.slice(0, 10).map((term) => `<a href="https://search.rakuten.co.jp/search/mall/${encodeURIComponent(term)}/" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(term)}" data-click-area="related-search">${escapeHtml(term)}</a>`).join("")}
            </div>
          </div>
          ${topItem ? `
          <div class="side-affiliate">
            <img src="${escapeAttribute(topItem.imageUrl)}" alt="${escapeAttribute(topItem.name)}" loading="lazy">
            <span>広告 / 商品リンク</span>
            <strong>${escapeHtml(topItem.name)}</strong>
            <em>${escapeHtml(getValueLine(topItem))}</em>
            <a href="${escapeAttribute(railLink)}" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(topItem.name)}" data-click-area="side-ad">楽天の商品ページで確認</a>
          </div>` : `
          <div class="ad-slot compact">
            <span>関連候補</span>
            <strong>比較しやすい商品を追加予定</strong>
          </div>`}
        </aside>
      </section>
      <section class="faq-section" data-search="${escapeAttribute(buildSearchText(topic.title, faqs.map((faq) => `${faq.question} ${faq.answer}`)))}">
        <p class="eyebrow">FAQ</p>
        <h2>よくある確認ポイント</h2>
        ${faqs.map((faq) => `
          <details>
            <summary>${escapeHtml(faq.question)}</summary>
            <p>${escapeHtml(faq.answer)}</p>
          </details>
        `).join("")}
      </section>`
  });

  await writeFile(path.join(outDir, `${topic.slug}.html`), html);
}

async function writeStaticPages() {
  await writeFile(path.join(outDir, "disclosure.html"), layout({
    title: `広告掲載について - ${config.siteName}`,
    description: "広告とアフィリエイトリンクの開示",
    path: "disclosure.html",
    body: `
      <section class="page-heading">
        <p class="eyebrow">AD DISCLOSURE</p>
        <h1>広告掲載について</h1>
        <p>当サイト「${escapeHtml(config.siteName)}」に掲載している広告リンク、商品リンク、掲載基準について説明します。</p>
      </section>
      <section class="policy-grid">
        <article>
          <span>01</span>
          <h2>アフィリエイト広告について</h2>
          <p>当サイトは、楽天アフィリエイトをはじめとするアフィリエイトプログラムに参加しています。商品リンクを経由して購入や申込が発生した場合、運営者が紹介料を受け取ることがあります。</p>
        </article>
        <article>
          <span>02</span>
          <h2>読者の負担について</h2>
          <p>アフィリエイトリンクを経由しても、通常、読者が支払う商品価格が追加で上乗せされるものではありません。購入条件、送料、ポイント、クーポンなどは販売ページでご確認ください。</p>
        </article>
        <article>
          <span>03</span>
          <h2>掲載候補の選び方</h2>
          <p>掲載候補は、レビュー件数、平均評価、価格目安、季節性、比較しやすさ、日常で使いやすいかをもとに整理しています。広告報酬の有無だけで掲載を決めるものではありません。</p>
        </article>
        <article>
          <span>04</span>
          <h2>価格・在庫・商品情報について</h2>
          <p>商品価格、在庫状況、送料、ポイント条件、販売ページの表示内容は随時変動します。当サイトの情報は更新時点の公開データをもとにしているため、最新情報は各販売サイトでご確認ください。</p>
        </article>
        <article>
          <span>05</span>
          <h2>購入判断について</h2>
          <p>当サイトは買い物候補を整理するための参考情報を提供するサイトです。商品の購入や利用は、利用者ご自身の判断と責任において行ってください。</p>
        </article>
        <article>
          <span>06</span>
          <h2>お問い合わせ</h2>
          <p>広告掲載や商品情報に関するお問い合わせは、${escapeHtml(config.operator.name)}までご連絡ください。連絡先: ${escapeHtml(config.operator.contact)}</p>
        </article>
      </section>`
  }));

  await writeFile(path.join(outDir, "selection-policy.html"), layout({
    title: `比較方針 - ${config.siteName}`,
    description: "くらし道具ノートの商品候補の選び方と比較方針",
    path: "selection-policy.html",
    body: `
      <section class="page-heading">
        <p class="eyebrow">EDITORIAL POLICY</p>
        <h1>比較方針</h1>
        <p>くらし道具ノートでは、買い物前に候補を絞りやすくするため、価格、レビュー件数、平均評価、季節性、日常での使いやすさを軸に商品情報を整理します。</p>
      </section>
      <section class="policy-grid">
        <article>
          <span>01</span>
          <h2>価格だけで判断しない</h2>
          <p>同じ商品名でも容量、送料、ポイント条件、セット数が違う場合があります。価格はあくまで比較の入り口として扱います。</p>
        </article>
        <article>
          <span>02</span>
          <h2>レビューの量と安定感を見る</h2>
          <p>平均評価だけでなく、レビュー件数も重視します。件数が少ない高評価より、一定数のレビューがある候補を優先します。</p>
        </article>
        <article>
          <span>03</span>
          <h2>暮らしのタイミングに合わせる</h2>
          <p>水分補給、防災、年末掃除、季節ギフトなど、必要になりやすい時期に合わせて候補を見直します。</p>
        </article>
        <article>
          <span>04</span>
          <h2>最終確認は販売ページで行う</h2>
          <p>在庫、送料、クーポン、ポイント、返品条件は変わるため、購入前に楽天の販売ページで確認してください。</p>
        </article>
      </section>`
  }));

  const monthCards = getEventsByMonth().map(({ month, events }) => `
    <article class="month-card">
      <span>${month}月</span>
      <h2>${month}月の行事と買い物候補</h2>
      <div class="event-list">
        ${events.map((event) => `
          <section class="event-card">
            <img class="event-card-visual" src="${escapeAttribute(getSeasonalEventVisual(event))}" alt="" loading="lazy">
            <small>${escapeHtml(event.dateLabel)}</small>
            <h3>${escapeHtml(event.title)}</h3>
            <p>${escapeHtml(event.description)}</p>
            <div>
              ${event.keywords.map((keyword) => `<a href="https://search.rakuten.co.jp/search/mall/${encodeURIComponent(keyword)}/" rel="sponsored nofollow noopener" target="_blank" data-affiliate-click="${escapeAttribute(keyword)}" data-click-area="seasonal-calendar">${escapeHtml(keyword)}</a>`).join("")}
            </div>
          </section>
        `).join("")}
      </div>
    </article>
  `).join("");

  await writeFile(path.join(outDir, "seasonal-calendar.html"), layout({
    title: `季節の買い物カレンダー - ${config.siteName}`,
    description: "月ごとに見直しやすい日用品、食品、防災、ギフトの買い物候補",
    path: "seasonal-calendar.html",
    body: `
      <section class="page-heading">
        <p class="eyebrow">SEASONAL CALENDAR</p>
        <h1>年間イベント買い物カレンダー</h1>
        <p>祝日、学校行事、ギフト、天候、セール時期など、1年の暮らしで買い物が発生しやすいタイミングを月別にまとめています。</p>
      </section>
      <section class="month-grid">
        ${monthCards}
      </section>`
  }));

  await writeFile(path.join(outDir, "privacy.html"), layout({
    title: `プライバシーポリシー - ${config.siteName}`,
    description: "プライバシーポリシー",
    path: "privacy.html",
    body: `
      <section class="page-heading">
        <p class="eyebrow">PRIVACY POLICY</p>
        <h1>プライバシーポリシー</h1>
        <p>当サイト「${escapeHtml(config.siteName)}」の運営者情報、アフィリエイト、アクセス解析、Cookie、免責事項などについて記載します。</p>
      </section>
      <section class="policy-grid privacy-policy">
        <article>
          <span>01</span>
          <h2>運営者情報</h2>
          <p>当サイト「${escapeHtml(config.siteName)}」の運営に関するお問い合わせは、下記までご連絡ください。<br>運営者: ${escapeHtml(config.operator.name)}<br>連絡先: ${escapeHtml(config.operator.contact)}</p>
        </article>
        <article>
          <span>02</span>
          <h2>アフィリエイトプログラムについて</h2>
          <p>当サイトは、楽天アフィリエイトをはじめとする第三者が提供するアフィリエイトプログラムを利用して商品を紹介しています。当サイトのリンクを経由して商品が購入された場合、運営者が紹介料を受け取ることがあります。なお、商品の価格や在庫、詳細情報は各販売サイトの内容が優先されます。</p>
        </article>
        <article>
          <span>03</span>
          <h2>アクセス解析ツールについて</h2>
          <p>当サイトでは、サイトの利用状況を把握するためにGoogleアナリティクスなどのアクセス解析ツールを利用する場合があります。これらのツールはCookieを使用して匿名のトラフィックデータを収集します。収集される情報は匿名であり、個人を特定するものではありません。</p>
        </article>
        <article>
          <span>04</span>
          <h2>Cookieについて</h2>
          <p>当サイトでは、利便性向上やアクセス解析のためにCookieを使用する場合があります。ブラウザの設定によりCookieを無効にすることができますが、一部機能が正しく動作しない場合があります。</p>
        </article>
        <article>
          <span>05</span>
          <h2>免責事項</h2>
          <p>当サイトに掲載された情報の正確性には努めていますが、内容を保証するものではありません。商品情報は更新時点の公開データをもとに整理しており、最新の価格・在庫・仕様は各販売サイトでご確認ください。当サイトの利用によって生じたいかなる損害についても、運営者は責任を負いかねます。</p>
        </article>
        <article>
          <span>06</span>
          <h2>著作権について</h2>
          <p>当サイトに掲載している商品画像・情報の著作権は、各権利者に帰属します。</p>
        </article>
        <article>
          <span>07</span>
          <h2>プライバシーポリシーの変更</h2>
          <p>本ポリシーは、必要に応じて予告なく変更することがあります。</p>
        </article>
      </section>`
  }));

  await writeFile(path.join(outDir, "robots.txt"), [
    "User-agent: *",
    "Allow: /",
    `Sitemap: ${pageUrl("sitemap.xml")}`
  ].join("\n"));
}

async function writeJsonFeed(topicResults, dataMode) {
  const feed = {
    generatedAt: now.toISOString(),
    liveData: dataMode === "live",
    dataMode,
    season,
    topics: config.topics.map((topic) => ({
      slug: topic.slug,
      title: topic.title,
      keyword: topic.keyword,
      source: topicResults[topic.slug]?.source || "sample",
      items: topicResults[topic.slug]?.items || []
    }))
  };

  await writeFile(path.join(outDir, "feed.json"), JSON.stringify(feed, null, 2));
}

async function writeBuildReport(dataMode) {
  const report = {
    generatedAt: now.toISOString(),
    dataMode,
    diagnostics
  };
  await writeFile(path.join(outDir, "build-report.json"), JSON.stringify(report, null, 2));
}

async function writeCname() {
  const host = new URL(config.baseUrl).hostname;
  if (!host.endsWith("github.io")) {
    await writeFile(path.join(outDir, "CNAME"), `${host}\n`);
  }
}

async function writeSitemap() {
  const pages = [
    "index.html",
    "ranking.html",
    "shopping-intents.html",
    "guides.html",
    "disclosure.html",
    "privacy.html",
    "selection-policy.html",
    "seasonal-calendar.html",
    "bichiku/",
    ...config.topics.map((topic) => `${topic.slug}.html`)
  ];
  const urls = pages.map((page) => {
    const loc = pageUrl(page);
    return `  <url><loc>${escapeHtml(loc)}</loc><lastmod>${now.toISOString().slice(0, 10)}</lastmod></url>`;
  }).join("\n");

  await writeFile(path.join(outDir, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
}

function utilityBlock() {
  return `
    <div class="ad-notice">このサイトには広告リンクが含まれる場合があります。</div>
    <section class="site-search" role="search">
      <label for="site-search-input">検索</label>
      <div>
        <input id="site-search-input" type="search" placeholder="商品名・カテゴリ・キーワード" autocomplete="off" data-site-search>
        <button type="button" data-search-clear>クリア</button>
      </div>
      <p data-search-status>商品・カテゴリを検索</p>
    </section>`;
}

function analyticsScript() {
  const measurementId = String(config.analytics?.measurementId || "").trim();
  if (!measurementId) return "";
  const measurementLiteral = escapeJsSingleQuotedString(measurementId);
  const gtagSrc = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
  return `<!-- Google tag (gtag.js) -->
  <script async src="${escapeAttribute(gtagSrc)}"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', '${measurementLiteral}');
  </script>`;
}

function layout({ title, description, body, path = "index.html", structuredData = [], showUtility = true }) {
  const canonicalUrl = pageUrl(path);
  const baseStructuredData = [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": config.siteName,
      "url": pageUrl("index.html"),
      "description": config.description
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "name": config.operator.name,
      "url": pageUrl("index.html")
    }
  ];
  const jsonLd = [...baseStructuredData, ...structuredData]
    .map((data) => `<script type="application/ld+json">${escapeJsonForHtml(JSON.stringify(data))}</script>`)
    .join("\n  ");
  const analytics = analyticsScript();
  return `<!doctype html>
<html lang="${escapeAttribute(config.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttribute(description)}">
  <link rel="canonical" href="${escapeAttribute(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${escapeAttribute(config.siteName)}">
  <meta property="og:title" content="${escapeAttribute(title)}">
  <meta property="og:description" content="${escapeAttribute(description)}">
  <meta property="og:url" content="${escapeAttribute(canonicalUrl)}">
  <meta name="twitter:card" content="summary">
  <link rel="stylesheet" href="styles.css">
  ${jsonLd}
  ${analytics}
</head>
<body>
  <header class="site-header">
    <a class="brand" href="index.html">${escapeHtml(config.siteName)}</a>
    <nav>
      <a href="ranking.html">ランキング</a>
      <a href="shopping-intents.html">目的別</a>
      <a href="guides.html">選び方</a>
      <a href="index.html">買い物テーマ</a>
      <a href="selection-policy.html">比較方針</a>
      <a href="seasonal-calendar.html">季節</a>
      <a href="privacy.html">プライバシー</a>
    </nav>
  </header>
  <main>
    ${showUtility ? utilityBlock() : ""}
    ${body}
  </main>
  <footer class="site-footer">
    <div>
      <p>${escapeHtml(config.tagline)}</p>
      <p>商品情報は更新時点の公開データをもとに整理しています。</p>
    </div>
    <nav class="footer-links" aria-label="サイト情報">
      <a href="disclosure.html">広告掲載について</a>
      <a href="privacy.html">プライバシー</a>
    </nav>
  </footer>
  <script>
    (() => {
      const input = document.querySelector("[data-site-search]");
      const panel = document.querySelector(".site-search");
      const clearButton = document.querySelector("[data-search-clear]");
      const status = document.querySelector("[data-search-status]");
      const targets = Array.from(document.querySelectorAll("[data-search]"));
      if (!input || !panel || !targets.length) {
        if (panel) panel.hidden = true;
        return;
      }
      const aliases = [
        ["ポカリ", "ポカリスエット", "スポーツドリンク", "スポドリ", "アクエリアス", "イオンウォーター", "os1", "経口補水液", "水分補給", "熱中症対策", "飲料", "ドリンク"],
        ["サイダー", "ソーダ", "ラムネ", "炭酸", "炭酸水", "炭酸飲料", "コーラ", "スプライト", "三ツ矢", "カナダドライ", "ジンジャーエール"],
        ["水", "ミネラルウォーター", "天然水", "ペットボトル", "ケース買い", "箱買い", "まとめ買い"],
        ["お茶", "おちゃ", "麦茶", "緑茶", "ウーロン茶", "烏龍茶"],
        ["米", "こめ", "お米", "ごはん", "ご飯", "ライス", "白米", "玄米", "無洗米", "パックご飯", "パックごはん"],
        ["防災", "非常食", "備蓄", "保存食", "ローリングストック", "常温保存", "レトルト"],
        ["日用品", "消耗品", "生活用品", "洗剤", "柔軟剤", "詰め替え", "つめかえ", "大容量", "紙類"],
        ["トイレットペーパー", "トイレットロール", "ティッシュ", "ティッシュペーパー", "キッチンペーパー"],
        ["掃除", "そうじ", "清掃", "洗濯", "ランドリー", "カビ", "カビ取り", "除湿", "湿気", "梅雨", "消臭", "部屋干し", "浴室", "風呂", "洗濯槽"],
        ["保存容器", "タッパー", "フードコンテナ", "作り置き", "冷蔵庫", "収納", "キッチン収納", "ラック", "棚", "整理", "片付け", "密閉容器"],
        ["家電", "小型家電", "時短家電", "キッチン家電", "ケトル", "電気ケトル", "扇風機", "サーキュレーター", "送風", "ハンディファン", "卓上ファン"],
        ["タオル", "バスタオル", "フェイスタオル", "寝具", "枕", "まくら", "布団", "ふとん", "敷きパッド", "冷感", "バス用品", "快眠"],
        ["ギフト", "プレゼント", "贈答", "贈り物", "お礼", "お返し", "手土産", "差し入れ", "お中元", "御中元", "お歳暮", "御歳暮", "父の日", "母の日", "敬老の日", "誕生日", "内祝い", "スイーツ"]
      ];
      const toKatakana = (value) => value.replace(/[ぁ-ん]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 0x60));
      const compact = (value) => value.replace(/[\\s\\-_/・,，.。()（）［］【】\\[\\]]+/g, "");
      const normalize = (value) => compact(toKatakana(String(value || "").normalize("NFKC").toLowerCase()));
      const buildRakutenSearchUrl = (value) => "https://search.rakuten.co.jp/search/mall/" + encodeURIComponent(String(value || "").trim()) + "/";
      const buildAffiliateSearchUrl = (value) => {
        const targetUrl = buildRakutenSearchUrl(value);
        const templateLink = Array.from(document.querySelectorAll('a[href^="https://hb.afl.rakuten.co.jp/"]'))
          .map((link) => link.href)
          .find(Boolean);
        if (!templateLink) return targetUrl;
        try {
          const affiliateUrl = new URL(templateLink);
          affiliateUrl.searchParams.set("pc", targetUrl);
          affiliateUrl.searchParams.set("m", targetUrl);
          return affiliateUrl.toString();
        } catch {
          return targetUrl;
        }
      };
      const expandTerms = (query) => {
        const rawTerms = String(input.value || "").normalize("NFKC").toLowerCase().split(/[\\s　]+/).map(normalize).filter(Boolean);
        const terms = new Set(rawTerms);
        terms.add(query);
        for (const group of aliases) {
          const normalizedGroup = group.map(normalize);
          if (normalizedGroup.some((term) => query.includes(term))) {
            normalizedGroup.forEach((term) => terms.add(term));
          }
        }
        return Array.from(terms).filter(Boolean);
      };
      const applySearch = () => {
        const query = normalize(input.value).trim();
        const terms = expandTerms(query);
        let visible = 0;
        for (const target of targets) {
          const searchable = normalize(target.dataset.search);
          const hit = !query || terms.some((term) => searchable.includes(term));
          target.classList.toggle("is-hidden", !hit);
          if (hit) visible += 1;
        }
        if (!query) {
          status.textContent = "商品・カテゴリを検索";
          return;
        }
        const searchUrl = buildAffiliateSearchUrl(input.value);
        status.innerHTML = visible + "件表示 / 見つからない場合は <a href=\\"" + searchUrl.replace(/"/g, "%22") + "\\" rel=\\"sponsored nofollow noopener\\" target=\\"_blank\\">楽天で検索</a>";
      };
      input.addEventListener("input", applySearch);
      clearButton.addEventListener("click", () => {
        input.value = "";
        input.focus();
        applySearch();
      });

      document.addEventListener("click", (event) => {
        const link = event.target.closest("[data-affiliate-click]");
        if (!link) return;
        const payload = {
          label: link.dataset.affiliateClick || link.textContent.trim(),
          area: link.dataset.clickArea || "unknown",
          href: link.href,
          page: location.pathname,
          at: new Date().toISOString()
        };
        try {
          const key = "affiliate_clicks";
          const current = JSON.parse(localStorage.getItem(key) || "[]");
          current.push(payload);
          localStorage.setItem(key, JSON.stringify(current.slice(-50)));
        } catch {}
        if (window.gtag) {
          window.gtag("event", "affiliate_click", {
            event_category: "affiliate",
            event_label: payload.label,
            click_area: payload.area
          });
        }
        if (window.plausible) {
          window.plausible("Affiliate Click", {
            props: {
              label: payload.label,
              area: payload.area
            }
          });
        }
      });
    })();
  </script>
</body>
</html>`;
}

function formatPrice(value) {
  if (!value) return "価格確認";
  return new Intl.NumberFormat("ja-JP", { style: "currency", currency: config.currency }).format(value);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function stripHtml(value) {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function shortTitle(value) {
  return String(value)
    .replace("のまとめ買い", "")
    .replace("の補充", "")
    .replace("候補", "")
    .trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeJsonForHtml(value) {
  return String(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function escapeJsSingleQuotedString(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
    .replaceAll("<", "\\x3c");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function getEnvValue(name) {
  return String(process.env[name] || "").trim();
}
