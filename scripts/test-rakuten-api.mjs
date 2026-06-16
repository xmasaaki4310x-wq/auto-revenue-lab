import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const config = JSON.parse(await readFile(path.join(root, "src", "config.json"), "utf8"));
const rakuten = config.rakuten;

const applicationId = env(rakuten.applicationIdEnv);
const accessKey = env(rakuten.accessKeyEnv);
const affiliateId = env(rakuten.affiliateIdEnv);
const keyword = env("RAKUTEN_TEST_KEYWORD") || "coffee";

if (!applicationId || !accessKey) {
  console.error("Missing RAKUTEN_APPLICATION_ID or RAKUTEN_ACCESS_KEY.");
  console.error("Run scripts/test-rakuten-local.ps1 and paste the values from Rakuten Developers.");
  process.exit(1);
}

console.log("Rakuten API local test");
console.log(`keyword: ${keyword}`);
console.log(`applicationId length: ${applicationId.length}`);
console.log(`accessKey length: ${accessKey.length}`);
console.log(`affiliateId present: ${affiliateId ? "yes" : "no"}`);

const withoutAffiliate = await runRequest({ includeAffiliateId: false });
const withAffiliate = affiliateId
  ? await runRequest({ includeAffiliateId: true })
  : { ok: false, skipped: true };

if (!withoutAffiliate.ok && !withAffiliate.ok) {
  process.exit(1);
}

function env(name) {
  return String(process.env[name] || "").trim();
}

async function runRequest({ includeAffiliateId }) {
  const params = new URLSearchParams({
    applicationId,
    accessKey,
    keyword,
    format: "json",
    formatVersion: "2",
    hits: "3"
  });

  if (includeAffiliateId && affiliateId) {
    params.set("affiliateId", affiliateId);
  }

  const url = `https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260401?${params}`;
  console.log("");
  console.log(includeAffiliateId ? "Test B: with affiliateId" : "Test A: without affiliateId");

  const response = await fetch(url);
  const text = await response.text();
  console.log(`status: ${response.status}`);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.log("response was not JSON");
    console.log(text.slice(0, 500));
    return { ok: response.ok };
  }

  if (!response.ok) {
    console.log(`error: ${data.error || data.message || "unknown"}`);
    console.log(`error_description: ${data.error_description || ""}`);
    return { ok: false };
  }

  console.log(`count: ${data.count}`);
  console.log(`items returned: ${Array.isArray(data.items) ? data.items.length : 0}`);

  const first = data.items?.[0]?.Item || data.items?.[0];
  if (first) {
    console.log(`first item: ${first.itemName || "(no name)"}`);
    console.log(`has affiliateUrl: ${first.affiliateUrl ? "yes" : "no"}`);
    console.log(`has image: ${first.mediumImageUrls?.length ? "yes" : "no"}`);
  }

  return { ok: true };
}
