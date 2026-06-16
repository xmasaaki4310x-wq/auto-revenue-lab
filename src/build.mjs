import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "site");
const offline = process.argv.includes("--offline");

const config = JSON.parse(await readFile(path.join(root, "src", "config.json"), "utf8"));
const samples = JSON.parse(await readFile(path.join(root, "src", "sample-products.json"), "utf8"));
const now = new Date();

await mkdir(outDir, { recursive: true });
await copyFile(path.join(root, "src", "styles.css"), path.join(outDir, "styles.css"));

const liveEnabled = hasRakutenKeys(config) && !offline;
const topicResults = {};

for (const topic of config.topics) {
  const liveItems = liveEnabled ? await fetchRakutenItems(topic, config).catch((error) => {
    console.warn(`Rakuten fetch failed for ${topic.keyword}: ${error.message}`);
    return [];
  }) : [];
  const items = (liveItems.length ? liveItems : samples[topic.slug] || [])
    .map(normalizeItem)
    .filter((item) => item.name && item.url)
    .map((item) => ({ ...item, score: scoreItem(item) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.maxItemsPerTopic);

  topicResults[topic.slug] = items;
  await writeTopicPage(topic, items);
}

await writeHomePage(topicResults);
await writeStaticPages();
await writeJsonFeed(topicResults);
await writeSitemap();

console.log(`Built ${outDir}${liveEnabled ? " using Rakuten API" : " using sample/offline data"}.`);

function hasRakutenKeys(siteConfig) {
  const rakuten = siteConfig.rakuten;
  return Boolean(
    process.env[rakuten.applicationIdEnv] &&
    process.env[rakuten.accessKeyEnv]
  );
}

async function fetchRakutenItems(topic, siteConfig) {
  const rakuten = siteConfig.rakuten;
  const params = new URLSearchParams({
    applicationId: process.env[rakuten.applicationIdEnv],
    accessKey: process.env[rakuten.accessKeyEnv],
    affiliateId: process.env[rakuten.affiliateIdEnv] || "",
    keyword: topic.keyword,
    format: "json",
    formatVersion: "2",
    hits: String(siteConfig.maxItemsPerTopic),
    availability: "1",
    imageFlag: "1",
    hasReviewFlag: "1",
    minAffiliateRate: String(rakuten.minAffiliateRate),
    sort: "-affiliateRate",
    elements: "itemName,itemPrice,itemUrl,affiliateUrl,mediumImageUrls,reviewAverage,reviewCount,affiliateRate,itemCaption"
  });

  const endpoint = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?${params}`;
  const response = await fetch(endpoint, {
    headers: { "User-Agent": "auto-revenue-lab/0.1" }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  return Array.isArray(data.items) ? data.items : [];
}

function normalizeItem(raw) {
  const imageUrl = raw.mediumImageUrls?.[0]?.imageUrl?.replace("?_ex=128x128", "") || "";
  const reviewAverage = Number(raw.reviewAverage || 0);
  const reviewCount = Number(raw.reviewCount || 0);
  const affiliateRate = Number(raw.affiliateRate || 0);
  const price = Number(raw.itemPrice || 0);
  const reason = makeReason({ reviewAverage, reviewCount, affiliateRate, price });

  return {
    name: String(raw.itemName || "").trim(),
    price,
    url: String(raw.affiliateUrl || raw.itemUrl || "").trim(),
    directUrl: String(raw.itemUrl || "").trim(),
    imageUrl,
    reviewAverage,
    reviewCount,
    affiliateRate,
    caption: stripHtml(String(raw.itemCaption || "")),
    reason
  };
}

function scoreItem(item) {
  const reviewWeight = Math.log10(item.reviewCount + 1) * 18;
  const ratingWeight = item.reviewAverage * 14;
  const rateWeight = item.affiliateRate * 9;
  const pricePenalty = item.price > 20000 ? 8 : item.price > 10000 ? 4 : 0;
  return Math.round((reviewWeight + ratingWeight + rateWeight - pricePenalty) * 10) / 10;
}

function makeReason(item) {
  const parts = [];
  if (item.reviewAverage >= config.rakuten.minReviewAverage) parts.push(`平均評価 ${item.reviewAverage.toFixed(1)}`);
  if (item.reviewCount >= config.rakuten.minReviewCount) parts.push(`レビュー ${item.reviewCount.toLocaleString("ja-JP")} 件`);
  if (item.affiliateRate > 0) parts.push(`料率 ${item.affiliateRate}%`);
  if (item.price > 0) parts.push(`${formatPrice(item.price)} 台`);
  return parts.length ? parts.join(" / ") : "比較候補として掲載";
}

async function writeHomePage(topicResults) {
  const topicCards = config.topics.map((topic) => {
    const top = topicResults[topic.slug]?.[0];
    return `
      <article class="topic-card">
        <a href="${topic.slug}.html" class="topic-link">
          <span class="topic-kicker">${escapeHtml(topic.keyword)}</span>
          <h2>${escapeHtml(topic.title)}</h2>
          <p>${escapeHtml(topic.angle)}</p>
          ${top ? `<strong>注目候補: ${escapeHtml(top.name)}</strong>` : ""}
        </a>
      </article>`;
  }).join("");

  const html = layout({
    title: config.siteName,
    description: config.description,
    body: `
      <section class="hero">
        <div>
          <p class="eyebrow">Auto affiliate discovery</p>
          <h1>${escapeHtml(config.siteName)}</h1>
          <p>${escapeHtml(config.description)}</p>
        </div>
        <aside class="status-panel">
          <span>最終更新</span>
          <strong>${formatDate(now)}</strong>
          <span>データ</span>
          <strong>${liveEnabled ? "Rakuten API" : "サンプル"}</strong>
        </aside>
      </section>
      <section class="topics-grid" aria-label="記事カテゴリ">
        ${topicCards}
      </section>
      <section class="plain-section">
        <h2>収益化の仕組み</h2>
        <p>商品リンク経由で購入や申込が発生すると、提携先の条件に応じて紹介料が発生します。掲載順位はレビュー、評価、価格、料率をもとに自動計算しています。</p>
      </section>`
  });

  await writeFile(path.join(outDir, "index.html"), html);
}

async function writeTopicPage(topic, items) {
  const cards = items.map((item) => `
    <article class="product-card">
      ${item.imageUrl ? `<img src="${escapeAttribute(item.imageUrl)}" alt="${escapeAttribute(item.name)}" loading="lazy">` : ""}
      <div class="product-body">
        <div class="product-meta">
          <span>${formatPrice(item.price)}</span>
          <span>score ${item.score}</span>
        </div>
        <h2>${escapeHtml(item.name)}</h2>
        <p>${escapeHtml(item.reason)}</p>
        ${item.caption ? `<p class="caption">${escapeHtml(truncate(item.caption, 140))}</p>` : ""}
        <a class="buy-link" href="${escapeAttribute(item.url)}" rel="sponsored nofollow noopener" target="_blank">詳細を見る</a>
      </div>
    </article>
  `).join("");

  const html = layout({
    title: `${topic.title} - ${config.siteName}`,
    description: topic.angle,
    body: `
      <nav class="breadcrumb"><a href="index.html">トップ</a> / ${escapeHtml(topic.title)}</nav>
      <section class="page-heading">
        <p class="eyebrow">${escapeHtml(topic.keyword)}</p>
        <h1>${escapeHtml(topic.title)}</h1>
        <p>${escapeHtml(topic.angle)}</p>
      </section>
      <section class="product-grid">
        ${cards || "<p>掲載候補がまだありません。</p>"}
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
        <p>掲載候補はレビュー数、平均評価、価格、紹介料率などの公開データをもとに自動整理します。最終的な購入判断は、販売ページの最新情報をご確認ください。</p>
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

async function writeJsonFeed(topicResults) {
  const feed = {
    generatedAt: now.toISOString(),
    liveData: liveEnabled,
    topics: config.topics.map((topic) => ({
      slug: topic.slug,
      title: topic.title,
      keyword: topic.keyword,
      items: topicResults[topic.slug] || []
    }))
  };

  await writeFile(path.join(outDir, "feed.json"), JSON.stringify(feed, null, 2));
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
      <a href="disclosure.html">広告掲載</a>
      <a href="privacy.html">プライバシー</a>
    </nav>
  </header>
  <main>
    <div class="ad-notice">このサイトには広告リンクが含まれる場合があります。リンク経由で購入や申込が発生すると、運営者が紹介料を受け取ることがあります。</div>
    ${body}
  </main>
  <footer class="site-footer">
    <p>${escapeHtml(config.tagline)}</p>
    <p>As an affiliate site, this site may earn from qualifying purchases.</p>
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
