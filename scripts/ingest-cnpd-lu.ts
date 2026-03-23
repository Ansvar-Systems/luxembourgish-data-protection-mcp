/**
 * Ingestion crawler for CNPD Luxembourg (cnpd.public.lu).
 *
 * Crawls decisions/sanctions and thematic guidance documents from the
 * Commission Nationale pour la Protection des Données website.  All
 * content is in French.
 *
 * Usage:
 *   npx tsx scripts/ingest-cnpd-lu.ts                 # full crawl
 *   npx tsx scripts/ingest-cnpd-lu.ts --resume        # skip already-stored items
 *   npx tsx scripts/ingest-cnpd-lu.ts --dry-run       # fetch + parse, no DB writes
 *   npx tsx scripts/ingest-cnpd-lu.ts --force          # drop tables and re-crawl
 *   npx tsx scripts/ingest-cnpd-lu.ts --decisions-only # crawl decisions only
 *   npx tsx scripts/ingest-cnpd-lu.ts --guidelines-only # crawl guidelines only
 *
 * Env:
 *   CNPD_LU_DB_PATH  — SQLite path (default: data/cnpd_lu.db)
 *   RATE_LIMIT_MS    — delay between requests in ms (default: 1500)
 *
 * Dependencies (add if missing):
 *   npm i cheerio
 *   npm i -D @types/cheerio   # (cheerio 1.x ships its own types)
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE_URL = "https://cnpd.public.lu";
const DECISIONS_LIST_PATH = "/fr/decisions-sanctions.html";
const DOSSIERS_INDEX_PATH = "/fr/dossiers-thematiques.html";
const PROFESSIONALS_PATHS = [
  "/fr/professionnels/obligations.html",
  "/fr/professionnels/dpo.html",
  "/fr/professionnels/outils-conformite.html",
  "/fr/professionnels/obligations-dga.html",
];
const PAGE_SIZE = 20;
const RATE_LIMIT_MS = parseInt(process.env["RATE_LIMIT_MS"] ?? "1500", 10);
const DB_PATH = process.env["CNPD_LU_DB_PATH"] ?? "data/cnpd_lu.db";
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const FLAG_RESUME = args.includes("--resume");
const FLAG_DRY_RUN = args.includes("--dry-run");
const FLAG_FORCE = args.includes("--force");
const FLAG_DECISIONS_ONLY = args.includes("--decisions-only");
const FLAG_GUIDELINES_ONLY = args.includes("--guidelines-only");

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

const stats = {
  decisionsListed: 0,
  decisionsInserted: 0,
  decisionsSkipped: 0,
  decisionsErrors: 0,
  guidelinesListed: 0,
  guidelinesInserted: 0,
  guidelinesSkipped: 0,
  guidelinesErrors: 0,
  httpRequests: 0,
  httpErrors: 0,
};

// ---------------------------------------------------------------------------
// HTTP helpers with retry logic
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      stats.httpRequests++;
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Ansvar-CNPD-Crawler/1.0 (+https://ansvar.eu; data-protection-research)",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "fr-LU,fr;q=0.9",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        console.error(
          `  HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        stats.httpErrors++;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BACKOFF_MS * attempt);
          continue;
        }
        return null;
      }

      return await response.text();
    } catch (err) {
      stats.httpErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `  Fetch error for ${url}: ${msg} (attempt ${attempt}/${MAX_RETRIES})`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  return null;
}

async function rateLimit(): Promise<void> {
  await sleep(RATE_LIMIT_MS);
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (FLAG_FORCE && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

// ---------------------------------------------------------------------------
// Decision parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract a reference number from a decision title.
 * Titles follow patterns like:
 *   "Délibération N° 12FR/du 22 juin 2022 – amende"
 *   "Délibération n° 15FR/2021 du 12 mai 2021 – amende"
 *   "Délibération N° 3FR/2025 du 30 avril 2025 – amende et mesures correctrices"
 */
function extractReference(title: string): string {
  // Try to extract a structured reference like "3FR/2025" or "12FR/du"
  const refMatch = title.match(
    /[Nn]°?\s*(\d+FR\/(?:du\s+)?(?:\d{4})?)/i,
  );
  if (refMatch?.[1]) {
    return `CNPD-${refMatch[1].replace(/\s+/g, "").replace(/\/du$/i, "")}`;
  }

  // Fallback: build from the decision page URL slug
  return "";
}

/**
 * Parse a French date string like "22 juin 2022" or "30/04/2025" to ISO date.
 */
function parseFrenchDate(raw: string): string | null {
  const months: Record<string, string> = {
    janvier: "01",
    février: "02",
    fevrier: "02",
    mars: "03",
    avril: "04",
    mai: "05",
    juin: "06",
    juillet: "07",
    août: "08",
    aout: "08",
    septembre: "09",
    octobre: "10",
    novembre: "11",
    décembre: "12",
    decembre: "12",
  };

  // DD/MM/YYYY
  const slashMatch = raw.match(/(\d{1,2})\/(\d{2})\/(\d{4})/);
  if (slashMatch) {
    const [, day, month, year] = slashMatch;
    return `${year}-${month}-${day!.padStart(2, "0")}`;
  }

  // "22 juin 2022"
  const textMatch = raw.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (textMatch) {
    const [, day, monthWord, year] = textMatch;
    const month = months[monthWord!.toLowerCase()];
    if (month) {
      return `${year}-${month}-${day!.padStart(2, "0")}`;
    }
  }

  return null;
}

/**
 * Extract the decision type from the title suffix after the dash.
 * E.g. "– amende et mesures correctrices" → "amende et mesures correctrices"
 *      "– clôture du dossier" → "clôture"
 */
function extractDecisionType(title: string): string {
  const dashMatch = title.match(/[–—-]\s*(.+)$/);
  if (!dashMatch?.[1]) return "décision";

  const suffix = dashMatch[1].trim().toLowerCase();
  if (suffix.includes("amende") && suffix.includes("mesures correctrices")) {
    return "sanction";
  }
  if (suffix.includes("amende")) return "sanction";
  if (suffix.includes("mesures correctrices")) return "mesures correctrices";
  if (suffix.includes("clôture") || suffix.includes("cloture")) {
    return "clôture";
  }
  if (suffix.includes("injonction")) return "injonction";
  return "décision";
}

/**
 * Try to extract a fine amount from text (e.g. "amende de 240.000 euros",
 * "746 millions d'euros").
 */
function extractFineAmount(text: string): number | null {
  // "X millions d'euros"
  const millionMatch = text.match(
    /(\d[\d\s.,]*)\s*millions?\s+d['']euros/i,
  );
  if (millionMatch?.[1]) {
    const num = parseFloat(
      millionMatch[1].replace(/\s/g, "").replace(/,/g, "."),
    );
    if (!isNaN(num)) return num * 1_000_000;
  }

  // "amende de X.XXX euros" or "amende de X euros"
  const amendeMatch = text.match(
    /amende\s+de\s+([\d.,\s]+)\s*euros/i,
  );
  if (amendeMatch?.[1]) {
    const num = parseFloat(
      amendeMatch[1].replace(/\s/g, "").replace(/\./g, "").replace(/,/g, "."),
    );
    if (!isNaN(num)) return num;
  }

  // "X.XXX EUR" or "X EUR"
  const eurMatch = text.match(/([\d.,\s]+)\s*EUR\b/);
  if (eurMatch?.[1]) {
    const num = parseFloat(
      eurMatch[1].replace(/\s/g, "").replace(/\./g, "").replace(/,/g, "."),
    );
    if (!isNaN(num)) return num;
  }

  return null;
}

/**
 * Extract GDPR article references from text.
 * Looks for patterns like "art. 5", "article 28", "art. 6(1)(f)".
 */
function extractGdprArticles(text: string): string[] {
  const articles = new Set<string>();
  const pattern = /(?:art(?:icle)?\.?\s*)(\d{1,3})/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const num = parseInt(match[1]!, 10);
    // GDPR articles range from 1 to 99
    if (num >= 1 && num <= 99) {
      articles.add(String(num));
    }
  }
  return [...articles].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

/**
 * Map common GDPR topics found in text to our topic IDs.
 */
function inferTopics(text: string): string[] {
  const topics: string[] = [];
  const lowerText = text.toLowerCase();

  const topicMap: Array<{ id: string; keywords: string[] }> = [
    {
      id: "sous_traitance",
      keywords: ["sous-traitant", "sous-traitance", "processor", "art. 28", "article 28"],
    },
    {
      id: "vidéosurveillance",
      keywords: ["vidéosurveillance", "vidéo-surveillance", "caméra", "surveillance vidéo"],
    },
    {
      id: "cookies",
      keywords: ["cookie", "traceur", "tracker", "pixel"],
    },
    {
      id: "transferts",
      keywords: [
        "transfert international",
        "pays tiers",
        "transferts de données",
        "art. 44",
        "art. 45",
        "art. 46",
        "art. 49",
      ],
    },
    {
      id: "consentement",
      keywords: ["consentement", "art. 7", "base légale"],
    },
    {
      id: "analyse_impact",
      keywords: [
        "analyse d'impact",
        "aipd",
        "dpia",
        "art. 35",
        "évaluation d'impact",
      ],
    },
    {
      id: "droit_acces",
      keywords: [
        "droit d'accès",
        "demande d'accès",
        "art. 15",
        "droit des personnes",
      ],
    },
    {
      id: "violation_donnees",
      keywords: [
        "violation de données",
        "data breach",
        "art. 33",
        "art. 34",
        "notification de violation",
        "faille de sécurité",
      ],
    },
    {
      id: "secteur_financier",
      keywords: [
        "secteur financier",
        "bancaire",
        "banque",
        "assurance",
        "fonds d'investissement",
        "cssf",
        "paiement",
      ],
    },
  ];

  for (const { id, keywords } of topicMap) {
    if (keywords.some((kw) => lowerText.includes(kw))) {
      topics.push(id);
    }
  }

  return topics;
}

// ---------------------------------------------------------------------------
// Crawl: Decisions listing
// ---------------------------------------------------------------------------

interface DecisionListItem {
  url: string;
  title: string;
  date: string | null;
  description: string;
}

async function crawlDecisionsList(): Promise<DecisionListItem[]> {
  const items: DecisionListItem[] = [];
  let offset = 0;
  let hasMore = true;

  console.log("\n--- Crawling decisions index ---");

  while (hasMore) {
    const url =
      offset === 0
        ? `${BASE_URL}${DECISIONS_LIST_PATH}`
        : `${BASE_URL}${DECISIONS_LIST_PATH}?b=${offset}`;

    console.log(`  Fetching listing page: ${url}`);
    const html = await fetchPage(url);
    if (!html) {
      console.error(`  Failed to fetch listing at offset ${offset}, stopping.`);
      break;
    }

    const $ = cheerio.load(html);

    // Decisions are in an ordered list <ol> within the main content area.
    // Each <li> contains a heading with an <a> link and a nested <ul> with metadata.
    const listItems = $("ol li").toArray();
    let pageCount = 0;

    for (const li of listItems) {
      const $li = $(li);
      const $link = $li.find("a").first();
      const href = $link.attr("href");
      const linkText = $link.text().trim();

      if (!href || !linkText) continue;
      // Filter to decision pages only
      if (!href.includes("/decisions-sanctions/")) continue;

      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;

      // Nested <ul><li> items contain date and description
      const metaItems = $li.find("ul li").toArray();
      let date: string | null = null;
      const descParts: string[] = [];

      for (const metaLi of metaItems) {
        const text = $(metaLi).text().trim();
        // First item with a date pattern is the date
        if (!date && /\d{2}\/\d{2}\/\d{4}/.test(text)) {
          date = parseFrenchDate(text);
        } else if (text.length > 0) {
          descParts.push(text);
        }
      }

      items.push({
        url: fullUrl,
        title: linkText,
        date,
        description: descParts.join(" — "),
      });

      pageCount++;
    }

    console.log(`  Found ${pageCount} decisions on this page`);
    stats.decisionsListed += pageCount;

    // If we got a full page, there might be more
    if (pageCount >= PAGE_SIZE) {
      offset += PAGE_SIZE;
      await rateLimit();
    } else {
      hasMore = false;
    }
  }

  console.log(`  Total decisions listed: ${items.length}`);
  return items;
}

// ---------------------------------------------------------------------------
// Crawl: Individual decision page
// ---------------------------------------------------------------------------

interface ParsedDecision {
  reference: string;
  title: string;
  date: string | null;
  type: string;
  entity_name: string | null;
  fine_amount: number | null;
  summary: string;
  full_text: string;
  topics: string;
  gdpr_articles: string;
  status: string;
}

async function crawlDecisionPage(
  item: DecisionListItem,
): Promise<ParsedDecision | null> {
  const html = await fetchPage(item.url);
  if (!html) return null;

  const $ = cheerio.load(html);

  // Title from H1
  const h1 = $("h1").first().text().trim();
  const title = h1 || item.title;

  // Date — prefer the one parsed from the listing; fall back to page content
  let date = item.date;
  if (!date) {
    // Look for "Dernière mise à jour DD/MM/YYYY" or date in h1
    const dateFromH1 = parseFrenchDate(h1);
    if (dateFromH1) {
      date = dateFromH1;
    } else {
      const bodyText = $("body").text();
      const miseAJour = bodyText.match(
        /(?:Dernière mise à jour|Date de publication)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i,
      );
      if (miseAJour?.[1]) {
        date = parseFrenchDate(miseAJour[1]);
      }
    }
  }

  // Reference
  let reference = extractReference(title);
  if (!reference) {
    // Build from URL slug: /fr/decisions-sanctions/2023/decision-06-fr-2023.html
    const slugMatch = item.url.match(
      /decisions-sanctions\/(\d{4})\/([\w-]+)\.html/,
    );
    if (slugMatch) {
      reference = `CNPD-${slugMatch[2]!.toUpperCase()}`;
    } else {
      reference = `CNPD-DEC-${Date.now()}`;
    }
  }

  // Decision type
  const type = extractDecisionType(title);

  // Main body text.
  // CNPD decision pages typically have a short inline summary with the
  // violation categories, then link to a PDF for the full decision text.
  // We extract all inline text from the main content area.
  //
  // Remove header/footer/nav noise
  $("header, footer, nav, .nav--secondary, .page-footernav, script, style").remove();

  // Get the main content text
  const mainContent = $("#main, main, .content, article")
    .first()
    .text()
    .trim();

  // Fall back to body text if main selector didn't match
  let bodyText = mainContent || $("body").text().trim();

  // Clean up excessive whitespace
  bodyText = bodyText
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  // Also capture the description from the listing as supplementary context
  const descriptionText = item.description || "";

  // Build the full text from available content
  const fullText =
    bodyText.length > 100
      ? bodyText
      : [title, descriptionText, bodyText].filter(Boolean).join("\n\n");

  if (fullText.length < 20) {
    console.warn(`  Skipping ${reference}: insufficient text content`);
    return null;
  }

  // Summary: use the listing description or first ~500 chars of body
  const summary =
    descriptionText ||
    fullText.slice(0, 500).replace(/\s+\S*$/, "") + "…";

  // Fine amount
  const fine_amount =
    extractFineAmount(fullText) ?? extractFineAmount(title);

  // GDPR articles
  const articles = extractGdprArticles(fullText);

  // Topics
  const topics = inferTopics(fullText + " " + descriptionText);

  // Entity name — difficult to extract reliably from anonymized decisions.
  // Try to find patterns like "à l'encontre de [entity]" or "infligée à [entity]"
  let entity_name: string | null = null;
  const entityMatch = fullText.match(
    /(?:à l['']encontre (?:de |d[''])|infligée à |prononcée (?:à l['']encontre (?:de |d['']))?)([\w\s.àâäéèêëïîôùûüÿçœæ-]+?)(?:\s*(?:,|\.|\s+une\s+amende|\s+pour|\s+en\s+raison))/i,
  );
  if (entityMatch?.[1]) {
    const raw = entityMatch[1].trim();
    if (raw.length > 3 && raw.length < 120) {
      entity_name = raw;
    }
  }

  return {
    reference,
    title,
    date,
    type,
    entity_name,
    fine_amount,
    summary,
    full_text: fullText,
    topics: JSON.stringify(topics),
    gdpr_articles: JSON.stringify(articles),
    status: "final",
  };
}

// ---------------------------------------------------------------------------
// Crawl: Thematic dossiers (guidelines)
// ---------------------------------------------------------------------------

interface GuidelineListItem {
  url: string;
  title: string;
  type: string;
}

async function crawlDossierIndex(): Promise<GuidelineListItem[]> {
  const items: GuidelineListItem[] = [];

  console.log("\n--- Crawling thematic dossiers index ---");

  const html = await fetchPage(`${BASE_URL}${DOSSIERS_INDEX_PATH}`);
  if (!html) {
    console.error("  Failed to fetch dossiers index");
    return items;
  }

  const $ = cheerio.load(html);

  // Dossier links are <a> elements pointing to /fr/dossiers-thematiques/...
  $("a[href*='/dossiers-thematiques/']").each((_i, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();

    if (!href || !text) return;
    // Skip the index page itself and navigation duplicates
    if (href === DOSSIERS_INDEX_PATH) return;
    if (href.endsWith("/dossiers-thematiques.html")) return;
    // Skip already-collected URLs
    if (items.some((it) => it.url === `${BASE_URL}${href}`)) return;

    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    items.push({ url: fullUrl, title: text, type: "dossier thématique" });
  });

  console.log(`  Found ${items.length} thematic dossier entry pages`);
  return items;
}

/**
 * Recursively crawl a dossier page and its sub-pages to collect all
 * guidance content.
 */
async function crawlDossierTree(
  rootUrl: string,
  rootTitle: string,
  visited: Set<string>,
): Promise<GuidelineListItem[]> {
  if (visited.has(rootUrl)) return [];
  visited.add(rootUrl);

  const items: GuidelineListItem[] = [];

  const html = await fetchPage(rootUrl);
  if (!html) return items;

  const $ = cheerio.load(html);

  // Find sub-page links within the dossier
  const subLinks: Array<{ url: string; title: string }> = [];

  $("a[href*='/dossiers-thematiques/']").each((_i, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (!href || !text) return;

    const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
    // Only follow links deeper within the same dossier tree
    if (
      fullUrl !== rootUrl &&
      !visited.has(fullUrl) &&
      !fullUrl.endsWith("/dossiers-thematiques.html")
    ) {
      subLinks.push({ url: fullUrl, title: text });
    }
  });

  // The root dossier page itself is a guideline item
  items.push({ url: rootUrl, title: rootTitle, type: "dossier thématique" });

  // Crawl sub-pages
  for (const sub of subLinks) {
    await rateLimit();
    const subItems = await crawlDossierTree(sub.url, sub.title, visited);
    items.push(...subItems);
  }

  return items;
}

/**
 * Also crawl the professionals section for additional guidance.
 */
async function crawlProfessionalPages(): Promise<GuidelineListItem[]> {
  const items: GuidelineListItem[] = [];

  console.log("\n--- Crawling professionals section ---");

  for (const path of PROFESSIONALS_PATHS) {
    const url = `${BASE_URL}${path}`;
    const html = await fetchPage(url);
    if (!html) continue;

    const $ = cheerio.load(html);
    const pageTitle = $("h1").first().text().trim() || path;

    items.push({ url, title: pageTitle, type: "guide professionnel" });

    // Find sub-pages
    $("a[href*='/professionnels/']").each((_i, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (!href || !text) return;
      const fullUrl = href.startsWith("http") ? href : `${BASE_URL}${href}`;
      if (fullUrl !== url && !items.some((it) => it.url === fullUrl)) {
        items.push({ url: fullUrl, title: text, type: "guide professionnel" });
      }
    });

    await rateLimit();
  }

  console.log(`  Found ${items.length} professional guidance pages`);
  return items;
}

// ---------------------------------------------------------------------------
// Crawl: Individual guideline page
// ---------------------------------------------------------------------------

interface ParsedGuideline {
  reference: string | null;
  title: string;
  date: string | null;
  type: string;
  summary: string;
  full_text: string;
  topics: string;
  language: string;
}

async function crawlGuidelinePage(
  item: GuidelineListItem,
): Promise<ParsedGuideline | null> {
  const html = await fetchPage(item.url);
  if (!html) return null;

  const $ = cheerio.load(html);

  // Title
  const h1 = $("h1").first().text().trim();
  const title = h1 || item.title;

  // Date
  let date: string | null = null;
  const bodyText = $("body").text();
  const miseAJour = bodyText.match(
    /(?:Dernière mise à jour|Date de publication|Mise à jour)\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i,
  );
  if (miseAJour?.[1]) {
    date = parseFrenchDate(miseAJour[1]);
  }
  // Try date from "Première publication : DD/MM/YYYY"
  if (!date) {
    const pubMatch = bodyText.match(
      /Première publication\s*:?\s*(\d{1,2}\s+\w+\s+\d{4}|\d{2}\/\d{2}\/\d{4})/i,
    );
    if (pubMatch?.[1]) {
      date = parseFrenchDate(pubMatch[1]);
    }
  }

  // Remove chrome
  $("header, footer, nav, .nav--secondary, .page-footernav, script, style").remove();

  // Main content
  const mainContent = $("#main, main, .content, article")
    .first()
    .text()
    .trim();
  let fullText = mainContent || $("body").text().trim();

  // Clean whitespace
  fullText = fullText
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  if (fullText.length < 50) {
    console.warn(`  Skipping guideline "${title}": insufficient text content`);
    return null;
  }

  // Summary: first ~500 characters
  const summary =
    fullText.length > 500
      ? fullText.slice(0, 500).replace(/\s+\S*$/, "") + "…"
      : fullText;

  // Reference — build from URL slug
  let reference: string | null = null;
  const slugMatch = item.url.match(
    /\/([^/]+)\.html$/,
  );
  if (slugMatch?.[1]) {
    reference = `CNPD-GUIDE-${slugMatch[1].toUpperCase().replace(/[^A-Z0-9]/g, "-")}`;
  }

  // Topics
  const topics = inferTopics(fullText);

  return {
    reference,
    title,
    date,
    type: item.type,
    summary,
    full_text: fullText,
    topics: JSON.stringify(topics),
    language: "fr",
  };
}

// ---------------------------------------------------------------------------
// Database insertion
// ---------------------------------------------------------------------------

function insertDecision(db: Database.Database, d: ParsedDecision): boolean {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO decisions
        (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      d.reference,
      d.title,
      d.date,
      d.type,
      d.entity_name,
      d.fine_amount,
      d.summary,
      d.full_text,
      d.topics,
      d.gdpr_articles,
      d.status,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  DB insert failed for decision ${d.reference}: ${msg}`);
    return false;
  }
}

function insertGuidelineRow(
  db: Database.Database,
  g: ParsedGuideline,
): boolean {
  try {
    // For guidelines, use INSERT OR IGNORE on reference if we have one,
    // otherwise just INSERT (reference can be null and non-unique).
    if (g.reference) {
      // Check for existing by reference
      const existing = db
        .prepare("SELECT id FROM guidelines WHERE reference = ?")
        .get(g.reference) as { id: number } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE guidelines
           SET title = ?, date = ?, type = ?, summary = ?, full_text = ?, topics = ?, language = ?
           WHERE reference = ?`,
        ).run(
          g.title,
          g.date,
          g.type,
          g.summary,
          g.full_text,
          g.topics,
          g.language,
          g.reference,
        );
        return true;
      }
    }

    db.prepare(
      `INSERT INTO guidelines
        (reference, title, date, type, summary, full_text, topics, language)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      g.reference,
      g.title,
      g.date,
      g.type,
      g.summary,
      g.full_text,
      g.topics,
      g.language,
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  DB insert failed for guideline "${g.title}": ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resume support
// ---------------------------------------------------------------------------

function getExistingReferences(db: Database.Database): Set<string> {
  const refs = new Set<string>();

  const decisionRefs = db
    .prepare("SELECT reference FROM decisions")
    .all() as Array<{ reference: string }>;
  for (const r of decisionRefs) {
    refs.add(r.reference);
  }

  const guidelineRefs = db
    .prepare("SELECT reference FROM guidelines WHERE reference IS NOT NULL")
    .all() as Array<{ reference: string }>;
  for (const r of guidelineRefs) {
    refs.add(r.reference);
  }

  return refs;
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("CNPD Luxembourg Ingestion Crawler");
  console.log("==================================");
  console.log(`  Database:   ${DB_PATH}`);
  console.log(`  Rate limit: ${RATE_LIMIT_MS}ms`);
  console.log(
    `  Flags:      ${[
      FLAG_RESUME && "--resume",
      FLAG_DRY_RUN && "--dry-run",
      FLAG_FORCE && "--force",
      FLAG_DECISIONS_ONLY && "--decisions-only",
      FLAG_GUIDELINES_ONLY && "--guidelines-only",
    ]
      .filter(Boolean)
      .join(" ") || "(none)"}`,
  );

  const db = FLAG_DRY_RUN ? null : initDb();
  const existingRefs = db && FLAG_RESUME ? getExistingReferences(db) : new Set<string>();

  if (FLAG_RESUME) {
    console.log(`  Resuming: ${existingRefs.size} existing items in DB`);
  }

  // ---- Decisions ----

  if (!FLAG_GUIDELINES_ONLY) {
    const decisionList = await crawlDecisionsList();

    console.log(`\n--- Crawling ${decisionList.length} individual decision pages ---`);

    for (let i = 0; i < decisionList.length; i++) {
      const item = decisionList[i]!;
      const progress = `[${i + 1}/${decisionList.length}]`;

      // Quick resume check — extract reference from title before fetching
      const preRef = extractReference(item.title);
      if (FLAG_RESUME && preRef && existingRefs.has(preRef)) {
        console.log(`  ${progress} Skipping (resume): ${preRef}`);
        stats.decisionsSkipped++;
        continue;
      }

      console.log(`  ${progress} Fetching: ${item.url}`);
      await rateLimit();

      const parsed = await crawlDecisionPage(item);
      if (!parsed) {
        stats.decisionsErrors++;
        continue;
      }

      // Post-parse resume check
      if (FLAG_RESUME && existingRefs.has(parsed.reference)) {
        console.log(`  ${progress} Skipping (resume): ${parsed.reference}`);
        stats.decisionsSkipped++;
        continue;
      }

      if (FLAG_DRY_RUN) {
        console.log(
          `  ${progress} [DRY RUN] Would insert decision: ${parsed.reference} ` +
            `(${parsed.type}, fine: ${parsed.fine_amount ?? "n/a"}, ` +
            `text: ${parsed.full_text.length} chars)`,
        );
        stats.decisionsInserted++;
        continue;
      }

      if (db && insertDecision(db, parsed)) {
        stats.decisionsInserted++;
        console.log(
          `  ${progress} Inserted: ${parsed.reference} (${parsed.type}, ${parsed.full_text.length} chars)`,
        );
      } else {
        stats.decisionsErrors++;
      }
    }
  }

  // ---- Guidelines: thematic dossiers + professionals ----

  if (!FLAG_DECISIONS_ONLY) {
    const dossierEntries = await crawlDossierIndex();
    await rateLimit();

    // Crawl each dossier tree for sub-pages
    const visited = new Set<string>();
    const allGuidelineItems: GuidelineListItem[] = [];

    console.log(`\n--- Crawling dossier sub-pages ---`);

    for (const entry of dossierEntries) {
      await rateLimit();
      const treeItems = await crawlDossierTree(
        entry.url,
        entry.title,
        visited,
      );
      allGuidelineItems.push(...treeItems);
    }

    // Professional guidance pages
    const profItems = await crawlProfessionalPages();
    for (const pi of profItems) {
      if (!visited.has(pi.url)) {
        visited.add(pi.url);
        allGuidelineItems.push(pi);
      }
    }

    // Deduplicate by URL
    const uniqueGuidelines = new Map<string, GuidelineListItem>();
    for (const g of allGuidelineItems) {
      if (!uniqueGuidelines.has(g.url)) {
        uniqueGuidelines.set(g.url, g);
      }
    }

    const guidelineList = [...uniqueGuidelines.values()];
    stats.guidelinesListed = guidelineList.length;

    console.log(
      `\n--- Crawling ${guidelineList.length} individual guideline pages ---`,
    );

    for (let i = 0; i < guidelineList.length; i++) {
      const item = guidelineList[i]!;
      const progress = `[${i + 1}/${guidelineList.length}]`;

      // Resume check by URL-derived reference
      const slugMatch = item.url.match(/\/([^/]+)\.html$/);
      const preRef = slugMatch?.[1]
        ? `CNPD-GUIDE-${slugMatch[1].toUpperCase().replace(/[^A-Z0-9]/g, "-")}`
        : null;
      if (FLAG_RESUME && preRef && existingRefs.has(preRef)) {
        console.log(`  ${progress} Skipping (resume): ${preRef}`);
        stats.guidelinesSkipped++;
        continue;
      }

      console.log(`  ${progress} Fetching: ${item.url}`);
      await rateLimit();

      const parsed = await crawlGuidelinePage(item);
      if (!parsed) {
        stats.guidelinesErrors++;
        continue;
      }

      if (FLAG_RESUME && parsed.reference && existingRefs.has(parsed.reference)) {
        console.log(`  ${progress} Skipping (resume): ${parsed.reference}`);
        stats.guidelinesSkipped++;
        continue;
      }

      if (FLAG_DRY_RUN) {
        console.log(
          `  ${progress} [DRY RUN] Would insert guideline: ${parsed.reference ?? "(no ref)"} ` +
            `"${parsed.title.slice(0, 60)}" (${parsed.full_text.length} chars)`,
        );
        stats.guidelinesInserted++;
        continue;
      }

      if (db && insertGuidelineRow(db, parsed)) {
        stats.guidelinesInserted++;
        console.log(
          `  ${progress} Inserted: ${parsed.reference ?? "(no ref)"} ` +
            `"${parsed.title.slice(0, 60)}" (${parsed.full_text.length} chars)`,
        );
      } else {
        stats.guidelinesErrors++;
      }
    }
  }

  // ---- Summary ----

  if (db) {
    const decisionCount = (
      db.prepare("SELECT count(*) as cnt FROM decisions").get() as {
        cnt: number;
      }
    ).cnt;
    const guidelineCount = (
      db.prepare("SELECT count(*) as cnt FROM guidelines").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\n==================================");
    console.log("Database totals:");
    console.log(`  Decisions:  ${decisionCount}`);
    console.log(`  Guidelines: ${guidelineCount}`);
    db.close();
  }

  console.log("\nCrawl statistics:");
  console.log(`  Decisions  — listed: ${stats.decisionsListed}, inserted: ${stats.decisionsInserted}, skipped: ${stats.decisionsSkipped}, errors: ${stats.decisionsErrors}`);
  console.log(`  Guidelines — listed: ${stats.guidelinesListed}, inserted: ${stats.guidelinesInserted}, skipped: ${stats.guidelinesSkipped}, errors: ${stats.guidelinesErrors}`);
  console.log(`  HTTP       — requests: ${stats.httpRequests}, errors: ${stats.httpErrors}`);
  console.log(`\nDone.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
