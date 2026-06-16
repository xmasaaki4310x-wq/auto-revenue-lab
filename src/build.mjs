import { mkdir, readFile, writeFile, copyFile, cp, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "site");
const offline = process.argv.includes("--offline");

const config = JSON.parse(await readFile(path.join(root, "src", "config.json"), "utf8"));
const samples = JSON.parse(await readFile(path.join(root, "src", "sample-products.json"), "utf8"));
const now = new Date();
const season = getSeason(now);
const diagnostics = [];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await copyFile(path.join(root, "src", "styles.css"), path.join(outDir, "styles.css"));
await cp(path.join(root, "src", "assets"), path.join(outDir, "assets"), { recursive: true });

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
  const normalizedItems = rawItems
    .map((raw) => normalizeItem(raw, topic, source))
    .filter((item) => item.name)
    .map((item) => source === "sample" ? { ...item, url: "", directUrl: "" } : item)
    .map((item) => ({ ...item, score: scoreItem(item) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxItemsPerTopic);

  topicResults[topic.slug] = {
    items: normalizedItems,
    source,
    keyword: fetchResult.keyword,
    reason: fetchResult.reason
  };

  diagnostics.push({
    slug: topic.slug,
    source,
    keyword: fetchResult.keyword,
    reason: fetchResult.reason,
    count: normalizedItems.length
  });

  await writeTopicPage(topic, normalizedItems, source);
}

const dataMode = liveTopicCount === 0 ? "sample" : liveTopicCount === config.topics.length ? "live" : "mixed";

await writeHomePage(topicResults, dataMode);
await writeStaticPages();
await writeJsonFeed(topicResults, dataMode);
await writeBuildReport(dataMode);
await writeSitemap();

console.log(`Built ${outDir}${dataMode === "live" ? " using Rakuten API" : " using sample/fallback data"}.`);

function hasRakutenKeys(siteConfig) {
  const rakuten = siteConfig.rakuten;
  return Boolean(
    process.env[rakuten.applicationIdEnv] &&
    process.env[rakuten.accessKeyEnv]
  );
}

async function checkRakutenAccess(siteConfig) {
  const testKeyword = siteConfig.topics[0]?.fallbackKeywords?.[0] || siteConfig.topics[0]?.keyword || "水";
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
  const keywords = [topic.keyword, ...(topic.fallbackKeywords || [])].slice(0, 2);
  let lastReason = "no-results";

  for (const keyword of keywords) {
    for (const relaxed of [false, true]) {
      try {
        const items = await fetchRakutenItems(keyword, siteConfig, relaxed, { accessKeyMode });
        if (items.length) {
          return {
            source: "live",
            items,
            keyword,
            reason: relaxed ? "relaxed-query" : "primary-query"
          };
        }
        lastReason = relaxed ? "relaxed-empty" : "primary-empty";
        await wait(250);
      } catch (error) {
        lastReason = error.message;
        console.warn(`Rakuten fetch failed for ${keyword}: ${error.message}`);
        if (error.message.includes("HTTP 403") || error.message.includes("HTTP 429")) {
          return {
            source: "sample",
            items: [],
            keyword: null,
            reason: error.message
          };
        }
      }
    }
  }

  return {
    source: "sample",
    items: [],
    keyword: null,
    reason: lastReason
  };
}

async function fetchRakutenItems(keyword, siteConfig, relaxed = false, options = {}) {
  const rakuten = siteConfig.rakuten;
  const accessKeyMode = options.accessKeyMode || "query";
  const params = new URLSearchParams({
    applicationId: process.env[rakuten.applicationIdEnv],
    affiliateId: process.env[rakuten.affiliateIdEnv] || "",
    keyword,
    format: "json",
    formatVersion: "2",
    hits: String(options.hits || siteConfig.maxItemsPerTopic)
  });

  if (accessKeyMode === "query") {
    params.set("accessKey", process.env[rakuten.accessKeyEnv]);
  }

  const endpoint = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?${params}`;
  const headers = {
    "User-Agent": "kurashi-dougu-note/0.6",
    Referer: `${siteConfig.baseUrl.replace(/\/$/, "")}/`
  };

  const response = await fetch(endpoint, {
    headers
  });

  if (!response.ok) {
    throw new Error(await formatRakutenError(response));
  }

  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
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

  return {
    name: String(raw.itemName || "").trim(),
    price,
    url: String(raw.affiliateUrl || raw.itemUrl || "").trim(),
    directUrl: String(raw.itemUrl || "").trim(),
    imageUrl: resolveImageUrl(raw, topic, source),
    reviewAverage,
    reviewCount,
    affiliateRate,
    caption: stripHtml(String(raw.itemCaption || "")),
    reason: makeReason({ reviewAverage, reviewCount, price }),
    fallbackUrl: buildRakutenSearchUrl(raw.itemName || topic.keyword),
    source
  };
}

function buildRakutenSearchUrl(value) {
  const query = String(value || "").trim();
  return query ? `https://search.rakuten.co.jp/search/mall/${encodeURIComponent(query)}/` : "https://search.rakuten.co.jp/";
}

function resolveImageUrl(raw, topic, source) {
  const candidate = raw.mediumImageUrls?.[0]?.imageUrl?.replace("?_ex=128x128", "") || "";
  if (source === "live" && candidate && !candidate.includes("placehold.co")) {
    return candidate;
  }
  return createTopicArt(topic, String(raw.itemName || "").trim());
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

async function writeHomePage(topicResults, dataMode) {
  const categoryNav = config.topics.map((topic, index) => `
    <a class="category-chip ${escapeAttribute(topic.accent || "")}" href="${topic.slug}.html">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <strong>${escapeHtml(shortTitle(topic.title))}</strong>
    </a>
  `).join("");

  const highlightItems = config.topics.map((topic, index) => {
    const topicResult = topicResults[topic.slug];
    const top = topicResult?.items?.[0];
    if (!top) return "";
    return `
      <article class="rank-card ${escapeAttribute(topic.accent || "")}">
        <a href="${topic.slug}.html">
          <span class="rank-number">${index + 1}</span>
          <img src="${escapeAttribute(top.imageUrl)}" alt="${escapeAttribute(top.name)}" loading="lazy">
          <div>
            <small>${escapeHtml(shortTitle(topic.title))}</small>
            <h3>${escapeHtml(top.name)}</h3>
            <p>${escapeHtml(top.reason)}</p>
          </div>
        </a>
      </article>`;
  }).join("");

  const topicCards = config.topics.map((topic) => {
    const topicResult = topicResults[topic.slug];
    const top = topicResult?.items?.[0];
    return `
      <article class="topic-card ${escapeAttribute(topic.accent || "")}">
        <a href="${topic.slug}.html" class="topic-link">
          <img class="topic-visual" src="assets/${escapeAttribute(topic.slug)}.svg" alt="${escapeAttribute(topic.title)}" loading="lazy">
          <span class="topic-kicker">${escapeHtml(topic.keyword)}</span>
          <h2>${escapeHtml(topic.title)}</h2>
          <p>${escapeHtml(topic.angle)}</p>
          <span class="topic-source ${topicResult?.source === "live" ? "live" : "sample"}">${topicResult?.source === "live" ? "実データ" : "サンプル表示"}</span>
          ${top ? `<strong>今の候補: ${escapeHtml(top.name)}</strong>` : ""}
        </a>
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
    body: `
      <section class="hero">
        <div class="hero-copy">
          <img class="hero-visual" src="assets/season-hero.svg" alt="季節の買い物候補イメージ" loading="lazy">
          <p class="eyebrow">${escapeHtml(season.label)}</p>
          <h1>${escapeHtml(config.siteName)}</h1>
          <p>${escapeHtml(config.description)}</p>
          <div class="season-tags" aria-label="季節の注目キーワード">
            ${season.keywords.map((keyword) => `<span>${escapeHtml(keyword)}</span>`).join("")}
          </div>
        </div>
        <aside class="status-panel">
          <span>最終更新</span>
          <strong>${formatDate(now)}</strong>
          <span>データ</span>
          <strong>${statusText}</strong>
          <small>${statusNote}</small>
        </aside>
      </section>
      <section class="category-nav" aria-label="カテゴリから探す">
        ${categoryNav}
      </section>
      <section class="feature-band" aria-label="このサイトの見方">
        <div>
          <span>01</span>
          <strong>売れ筋の流れを見る</strong>
          <p>季節イベントやまとめ買い需要に合う候補を中心に整理します。</p>
        </div>
        <div>
          <span>02</span>
          <strong>価格とレビューを比べる</strong>
          <p>安さだけでなく、レビュー件数と平均評価も並べて確認します。</p>
        </div>
        <div>
          <span>03</span>
          <strong>販売ページで最終確認</strong>
          <p>在庫、送料、クーポン、ポイント条件は購入前に公式ページで確認します。</p>
        </div>
      </section>
      <section class="section-heading">
        <div>
          <p class="eyebrow">TODAY'S PICKUP</p>
          <h2>今日チェックする買い物候補</h2>
        </div>
        <a href="feed.json">データを見る</a>
      </section>
      <section class="rank-grid" aria-label="今日の候補">
        ${highlightItems}
      </section>
      <section class="section-heading">
        <div>
          <p class="eyebrow">SHOPPING THEMES</p>
          <h2>暮らしのカテゴリ</h2>
        </div>
      </section>
      <section class="topics-grid" aria-label="買い物テーマ">
        ${topicCards}
      </section>
      <section class="content-with-rail">
        <div class="plain-section">
          <h2>掲載の考え方</h2>
          <p>このサイトは、日用品や食品などの買い物候補を整理するためのメモです。商品リンク経由で購入や申込が発生すると、提携先の条件に応じて紹介料が発生する場合がありますが、掲載文では価格、レビュー、季節性、比較しやすさを優先します。</p>
        </div>
        <aside class="ad-slot" aria-label="広告掲載枠">
          <span>広告掲載枠</span>
          <strong>季節特集や関連商品の掲載を想定</strong>
        </aside>
      </section>`
  });

  await writeFile(path.join(outDir, "index.html"), html);
}

async function writeTopicPage(topic, items, source) {
  const cards = items.map((item) => `
    <article class="product-card">
      ${item.imageUrl ? `<img src="${escapeAttribute(item.imageUrl)}" alt="${escapeAttribute(item.name)}" loading="lazy">` : ""}
      <div class="product-body">
        <div class="product-meta">
          <span>${formatPrice(item.price)}</span>
          <span>${item.reviewCount.toLocaleString("ja-JP")} reviews</span>
        </div>
        <h2>${escapeHtml(item.name)}</h2>
        <p>${escapeHtml(item.reason)}</p>
        ${item.caption ? `<p class="caption">${escapeHtml(truncate(item.caption, 130))}</p>` : ""}
        ${item.url
          ? `<a class="buy-link" href="${escapeAttribute(item.url)}" rel="sponsored nofollow noopener" target="_blank">販売ページで確認</a>`
          : `<a class="buy-link search" href="${escapeAttribute(item.fallbackUrl)}" rel="noopener" target="_blank">楽天で候補を見る</a>`}
      </div>
    </article>
  `).join("");

  const html = layout({
    title: `${topic.title} - ${config.siteName}`,
    description: topic.angle,
    body: `
      <nav class="breadcrumb"><a href="index.html">トップ</a> / ${escapeHtml(topic.title)}</nav>
      <section class="page-heading topic-heading ${escapeAttribute(topic.accent || "")}">
        <img class="topic-heading-visual" src="assets/${escapeAttribute(topic.slug)}.svg" alt="${escapeAttribute(topic.title)}" loading="lazy">
        <p class="eyebrow">${escapeHtml(topic.keyword)}</p>
        <h1>${escapeHtml(topic.title)}</h1>
        <p>${escapeHtml(topic.angle)}</p>
        ${source === "sample" ? `<div class="topic-alert">このテーマは現在サンプル表示です。実データ取得に成功すると販売ページへの実リンクと商品画像へ切り替わります。</div>` : ""}
      </section>
      <section class="content-with-rail">
        <div class="product-grid">
          ${cards || "<p>掲載候補がまだありません。</p>"}
        </div>
        <aside class="side-note">
          <span>比較メモ</span>
          <p>価格、送料、クーポン、ポイント条件は変わることがあります。購入前に販売ページの最新情報を確認してください。</p>
          <div class="ad-slot compact">
            <span>広告掲載枠</span>
            <strong>関連商品の紹介枠</strong>
          </div>
        </aside>
      </section>`
  });

  await writeFile(path.join(outDir, `${topic.slug}.html`), html);
}

async function writeStaticPages() {
  await writeFile(path.join(outDir, "disclosure.html"), layout({
    title: `広告掲載について - ${config.siteName}`,
    description: "広告とアフィリエイトリンクの開示",
    body: `
      <section class="page-heading">
        <h1>広告掲載について</h1>
        <p>当サイトにはアフィリエイト広告が含まれる場合があります。リンク経由で購入や申込が発生すると、運営者が紹介料を受け取ることがあります。</p>
      </section>
      <section class="plain-section">
        <h2>掲載基準</h2>
        <p>掲載候補はレビュー件数、平均評価、価格、季節性、比較しやすさなどの公開データをもとに整理します。最終的な購入判断は、販売ページの最新情報をご確認ください。</p>
      </section>`
  }));

  await writeFile(path.join(outDir, "privacy.html"), layout({
    title: `プライバシーポリシー - ${config.siteName}`,
    description: "プライバシーポリシー",
    body: `
      <section class="page-heading">
        <h1>プライバシーポリシー</h1>
        <p>当サイトは、アクセス解析や広告配信サービスを導入する場合があります。各サービスはCookie等を利用して利用状況を把握することがあります。</p>
      </section>
      <section class="plain-section">
        <h2>お問い合わせ</h2>
        <p>運営者: ${escapeHtml(config.operator.name)}<br>連絡先: ${escapeHtml(config.operator.contact)}</p>
      </section>`
  }));

  await writeFile(path.join(outDir, "robots.txt"), [
    "User-agent: *",
    "Allow: /",
    "Sitemap: sitemap.xml"
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

async function writeSitemap() {
  const pages = ["index.html", "disclosure.html", "privacy.html", ...config.topics.map((topic) => `${topic.slug}.html`)];
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const urls = pages.map((page) => {
    const loc = baseUrl ? `${baseUrl}/${page}` : page;
    return `  <url><loc>${escapeHtml(loc)}</loc><lastmod>${now.toISOString().slice(0, 10)}</lastmod></url>`;
  }).join("\n");

  await writeFile(path.join(outDir, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
}

function layout({ title, description, body }) {
  return `<!doctype html>
<html lang="${escapeAttribute(config.language)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttribute(description)}">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <header class="site-header">
    <a class="brand" href="index.html">${escapeHtml(config.siteName)}</a>
    <nav>
      <a href="index.html">買い物テーマ</a>
      <a href="disclosure.html">広告掲載</a>
      <a href="privacy.html">プライバシー</a>
    </nav>
  </header>
  <main>
    <div class="ad-notice">このサイトには広告リンクが含まれる場合があります。価格、在庫、送料、ポイント条件は販売ページでご確認ください。</div>
    ${body}
  </main>
  <footer class="site-footer">
    <p>${escapeHtml(config.tagline)}</p>
    <p>商品情報は更新時点の公開データをもとに整理しています。</p>
  </footer>
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

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
