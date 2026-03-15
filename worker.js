/**
 * AEO Audit MCP Server — Cloudflare Worker
 *
 * Implements MCP (Model Context Protocol) Streamable HTTP transport.
 * Exposes AEO (Answer Engine Optimization) audit tools for AI clients.
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST /mcp
 * Free to use — no auth required (lead gen for synligdigital.no)
 *
 * Tools:
 *   analyze_aeo(url)         — Full AEO audit (score 0-100, breakdown, recommendations)
 *   get_aeo_score(url)       — Quick score check (returns grade + number)
 *   check_ai_readiness(url)  — Check if AI assistants can read this site
 *
 * MCP Spec: https://spec.modelcontextprotocol.io/
 */

const UA = "Mozilla/5.0 (compatible; AEO-MCP/1.0; +https://synligdigital.no)";
const TIMEOUT_MS = 20000;
const SERVER_NAME = "aeo-audit";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";

// ─── CORS Headers ─────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Accept",
  "Access-Control-Max-Age": "86400",
};

// ─── HTML Parsing Utilities ──────────────────────────────────────────────────

function extractJsonLd(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      if (Array.isArray(data)) blocks.push(...data);
      else if (data["@graph"]) blocks.push(...data["@graph"]);
      else blocks.push(data);
    } catch { /* ignore invalid JSON-LD */ }
  }
  return blocks;
}

function extractMeta(html, name) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name.replace(":", "\\:")}["'][^>]*content=["']([^"']*)["']`,
    "i"
  );
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name.replace(":", "\\:")}["']`,
    "i"
  );
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/<[^>]+>/g, "").trim() : null;
}

function countTag(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, "gi");
  return (html.match(re) || []).length;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function wordCount(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

// ─── Analyzers ────────────────────────────────────────────────────────────────

const SPECIFIC_TYPES = [
  "dentist", "medicalclinic", "medicalbusiness", "physician",
  "autorepair", "autodealer", "legalservice", "attorney",
  "accountingservice", "financialservice", "realestateagent",
  "restaurant", "barorpub", "cafeoecoffeeshop",
  "beautysalon", "hairsalon", "dayspa", "healthclub",
  "plumber", "electrician", "hvacbusiness", "roofingcontractor",
  "generalcontractor", "locksmith",
];

function analyzeSchema(html) {
  const issues = [];
  const recommendations = [];
  const blocks = extractJsonLd(html);

  const types = [];
  function extractTypes(obj) {
    if (!obj || typeof obj !== "object") return;
    if (obj["@type"]) {
      const t = Array.isArray(obj["@type"]) ? obj["@type"] : [obj["@type"]];
      types.push(...t.map(s => s.toLowerCase()));
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) v.forEach(extractTypes);
      else if (typeof v === "object") extractTypes(v);
    }
  }
  blocks.forEach(extractTypes);

  const allJson = JSON.stringify(blocks).toLowerCase();
  const hasLocalBusiness = types.some(t => t === "localbusiness" || SPECIFIC_TYPES.includes(t));
  const hasSpecificType = types.some(t => SPECIFIC_TYPES.includes(t));
  const hasAggregateRating = allJson.includes("aggregaterating") || allJson.includes("ratingvalue");
  const hasOpeningHours = allJson.includes("openinghours");
  const hasGeo = allJson.includes('"geo"') || allJson.includes('"latitude"');
  const hasContactPoint = allJson.includes("contactpoint");
  const hasFaqPage = types.includes("faqpage");
  const hasService = types.includes("service") || allJson.includes("hasoffercatalog");
  const hasPerson = types.includes("person") || allJson.includes('"employee"');

  let score = 0;
  if (blocks.length === 0) {
    issues.push("No structured data (JSON-LD) found");
    recommendations.push("Add JSON-LD schema.org markup — the most important signal for AI visibility");
  } else {
    score += 4;
    if (hasLocalBusiness) {
      score += 3;
      if (hasSpecificType) score += 3;
      else recommendations.push("Use specific type (e.g. Dentist, Plumber) instead of generic LocalBusiness");
    } else {
      issues.push("Missing LocalBusiness schema");
      recommendations.push("Add @type matching your industry (Dentist, Plumber, LegalService, etc.)");
    }
    if (hasAggregateRating) score += 4;
    else recommendations.push("Add AggregateRating with star ratings from Google/Trustpilot");
    if (hasOpeningHours) score += 2;
    else recommendations.push("Add openingHours to schema");
    if (hasGeo) score += 2;
    else recommendations.push("Add geo coordinates (latitude/longitude)");
    if (hasContactPoint) score += 1;
    if (hasFaqPage) score += 3;
    else recommendations.push("Add FAQPage schema — AI assistants cite FAQ directly in answers");
    if (hasService) score += 2;
    else recommendations.push("Add hasOfferCatalog/Service for services");
    if (hasPerson) score += 1;
  }

  return {
    score: Math.min(25, score), max: 25,
    issues, recommendations,
    details: { hasLocalBusiness, hasSpecificType, hasAggregateRating, hasOpeningHours, hasGeo, hasFaqPage, hasService, schemaBlockCount: blocks.length },
  };
}

function analyzeMeta(html) {
  const issues = [];
  const recommendations = [];
  const title = extractTitle(html);
  const description = extractMeta(html, "description");
  const ogTitle = extractMeta(html, "og:title");
  const ogDesc = extractMeta(html, "og:description");
  const ogImage = extractMeta(html, "og:image");
  const canonical = /<link[^>]+rel=["']canonical["'][^>]*>/i.test(html);
  const viewport = extractMeta(html, "viewport");

  let score = 0;
  if (!title) {
    issues.push("Missing <title> tag");
    recommendations.push("Add a descriptive title (50-60 chars)");
  } else if (title.length < 20 || title.length > 70) {
    score += 2;
    recommendations.push(`Title is ${title.length} chars — ideal is 50-60`);
  } else {
    score += 5;
  }
  if (!description) {
    issues.push("Missing meta description");
    recommendations.push("Add meta description (130-160 chars) with service + location");
  } else if (description.length < 50 || description.length > 170) {
    score += 2;
    recommendations.push(`Meta description is ${description.length} chars — ideal is 130-160`);
  } else {
    score += 5;
  }
  if (ogTitle && ogDesc && ogImage) score += 5;
  else if (ogTitle || ogDesc) { score += 2; if (!ogImage) recommendations.push("Add og:image for social sharing"); }
  else recommendations.push("Add OpenGraph tags (og:title, og:description, og:image)");
  if (canonical) score += 3;
  else recommendations.push("Add canonical URL to prevent duplicate content");
  if (viewport) score += 2;
  else issues.push("Missing viewport meta — page not mobile-optimized");

  return {
    score: Math.min(20, score), max: 20,
    issues, recommendations,
    details: { title, titleLength: title ? title.length : 0, description, descriptionLength: description ? description.length : 0, hasOg: !!(ogTitle && ogDesc), hasCanonical: canonical },
  };
}

function analyzeContent(html) {
  const issues = [];
  const recommendations = [];
  const text = stripTags(html);
  const words = wordCount(text);
  const h1Count = countTag(html, "h1");
  const h2Count = countTag(html, "h2");
  const hasLocation = /stavanger|bergen|oslo|trondheim|norway|norge/i.test(html);
  const hasPrices = /\d+[\s.,]\d*\s*(kr|nok|,-|\$|usd|eur)/i.test(html);
  const hasFaq = /(?:faq|frequently asked|questions|q&a)/i.test(html) || countTag(html, "details") > 0;
  const hasPhone = /(?:\+\d{1,3}|tlf\.?|tel\.?|phone:?)[\s.-]?\d[\d\s.-]{6,}/i.test(html);
  const hasTeam = /(?:team|about|our\s+staff|staff|founder|ceo|our\s+experts)/i.test(html.toLowerCase());

  let score = 0;
  if (h1Count === 0) { issues.push("Missing H1 heading"); recommendations.push("Add one clear H1 with service + location"); }
  else if (h1Count === 1) score += 5;
  else { score += 3; recommendations.push(`${h1Count} H1 headings — keep just one`); }
  if (h2Count >= 3) score += 3;
  else if (h2Count > 0) score += 1;
  else recommendations.push("Add H2 headings for services, about, contact sections");
  if (words >= 500) score += 4;
  else if (words >= 200) score += 2;
  else { issues.push(`Low word count (${words} words)`); recommendations.push("Add more content (at least 300-500 words) describing services and expertise"); }
  if (hasLocation) score += 3;
  else { issues.push("No location signals found"); recommendations.push("Mention city/area explicitly in text and headings"); }
  if (hasPrices) score += 2;
  else recommendations.push("Add price information — AI assistants include this in answers");
  if (hasFaq) score += 3;
  else recommendations.push("Add an FAQ section — AI assistants cite directly from FAQ");
  if (hasPhone) score += 2;
  else recommendations.push("Add phone number in text format (not just image)");

  return {
    score: Math.min(22, score), max: 22,
    issues, recommendations,
    details: { words, h1Count, h2Count, hasLocation, hasPrices, hasFaq, hasTeam },
  };
}

function analyzeTechnical(html, robotsTxt, llmsTxt, statusCode, loadMs) {
  const issues = [];
  const recommendations = [];
  const hasSitemap = /sitemap/i.test(robotsTxt || "");
  const hasLlmsTxt = !!llmsTxt;
  const blocksGpt = /disallow.*GPTBot|user-agent.*GPTBot.*\nDisallow:\s*\//i.test(robotsTxt || "");
  const blocksClaude = /disallow.*ClaudeBot|user-agent.*ClaudeBot.*\nDisallow:\s*\//i.test(robotsTxt || "");
  const fast = loadMs < 2000;

  let score = 0;
  score += 3; // HTTPS confirmed
  if (robotsTxt) {
    if (!blocksGpt && !blocksClaude) score += 5;
    else {
      if (blocksGpt) { issues.push("robots.txt blocks GPTBot (ChatGPT)"); recommendations.push("Remove GPTBot block from robots.txt"); }
      if (blocksClaude) { issues.push("robots.txt blocks ClaudeBot"); recommendations.push("Remove ClaudeBot block"); }
      score += 1;
    }
  } else { score += 2; recommendations.push("Add robots.txt that explicitly allows AI crawlers"); }
  if (hasLlmsTxt) score += 5;
  else recommendations.push("Add /llms.txt — a new format specifically for AI readability");
  if (hasSitemap) score += 2;
  else recommendations.push("Add sitemap.xml");
  if (fast) score += 3;
  else recommendations.push(`Page load is ${loadMs}ms — optimize for speed`);
  if (statusCode === 200) score += 3;
  else if (statusCode === 0) { issues.push("Site unreachable"); score = 0; }

  return {
    score: Math.min(18, score), max: 18,
    issues, recommendations,
    details: { hasLlmsTxt, blocksGpt, blocksClaude, hasSitemap, loadMs, statusCode },
  };
}

function analyzeAISignals(html, llmsTxt) {
  const issues = [];
  const recommendations = [];
  const hasSpeakable = /speakable/i.test(html);
  const hasStatistics = /\d+%|\d+\s*(years|år|kunder|pasienter|clients)/i.test(html);
  const hasCitations = /(?:according to|source:|studier viser|forskning viser)/i.test(html);
  const hasH2H3Coverage = countTag(html, "h2") + countTag(html, "h3") >= 4;
  const hasVideo = /<video|youtube\.com\/embed|vimeo\.com\/video/i.test(html);
  const hasLlmsContent = !!(llmsTxt && llmsTxt.length > 100);

  let score = 0;
  if (hasSpeakable) score += 3;
  else recommendations.push("Add Speakable schema for voice assistant compatibility");
  if (hasStatistics) score += 2;
  else recommendations.push("Add statistics/numbers (years in business, number of clients) — AI cites specific data");
  if (hasCitations) score += 2;
  else recommendations.push("Add references to studies or authoritative sources");
  if (hasH2H3Coverage) score += 2;
  else recommendations.push("Add more H2/H3 headings to structure content for AI parsing");
  if (hasVideo) score += 1;
  if (hasLlmsContent) score += 3;
  else recommendations.push("Add /llms.txt with structured business description for AI assistants");

  return {
    score: Math.min(15, score), max: 15,
    issues, recommendations,
    details: { hasSpeakable, hasStatistics, hasCitations, hasH2H3Coverage, hasLlmsTxt: !!llmsTxt },
  };
}

// ─── Core Audit Function ─────────────────────────────────────────────────────

async function runAudit(url) {
  if (!url.startsWith("http")) url = "https://" + url;
  const urlObj = new URL(url);
  const origin = urlObj.origin;
  const start = Date.now();

  const fetchOpts = { headers: { "User-Agent": UA }, redirect: "follow" };
  const withTimeout = (p) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), TIMEOUT_MS))]);

  let html = "";
  let statusCode = 0;
  let finalUrl = url;
  let robotsTxt = null;
  let llmsTxt = null;

  try {
    const [mainRes, robotsRes, llmsRes] = await Promise.all([
      withTimeout(fetch(url, fetchOpts)),
      withTimeout(fetch(`${origin}/robots.txt`, fetchOpts)).catch(() => null),
      withTimeout(fetch(`${origin}/llms.txt`, fetchOpts)).catch(() => null),
    ]);
    statusCode = mainRes.status;
    finalUrl = mainRes.url;
    html = await mainRes.text();
    if (robotsRes && robotsRes.ok) robotsTxt = await robotsRes.text();
    if (llmsRes && llmsRes.ok) llmsTxt = await llmsRes.text();
  } catch (e) {
    statusCode = 0;
  }

  const loadMs = Date.now() - start;
  const schema = analyzeSchema(html);
  const meta = analyzeMeta(html);
  const content = analyzeContent(html);
  const technical = analyzeTechnical(html, robotsTxt, llmsTxt, statusCode, loadMs);
  const aiSignals = analyzeAISignals(html, llmsTxt);

  const totalScore = schema.score + meta.score + content.score + technical.score + aiSignals.score;

  function getGrade(s) {
    if (s >= 85) return "A";
    if (s >= 70) return "B";
    if (s >= 55) return "C";
    if (s >= 40) return "D";
    if (s >= 25) return "E";
    return "F";
  }

  return {
    url, finalUrl, statusCode, loadMs,
    totalScore, grade: getGrade(totalScore),
    breakdown: {
      schema: { score: schema.score, max: schema.max, details: schema.details },
      meta: { score: meta.score, max: meta.max, details: meta.details },
      content: { score: content.score, max: content.max, details: content.details },
      technical: { score: technical.score, max: technical.max, details: technical.details },
      aiSignals: { score: aiSignals.score, max: aiSignals.max, details: aiSignals.details },
    },
    issues: [...schema.issues, ...meta.issues, ...content.issues, ...technical.issues, ...aiSignals.issues],
    recommendations: [...schema.recommendations, ...meta.recommendations, ...content.recommendations, ...technical.recommendations, ...aiSignals.recommendations],
    auditedAt: new Date().toISOString(),
    learnMore: "https://synligdigital.no",
  };
}

// ─── MCP Tool Definitions ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "analyze_aeo",
    description: "Run a full AEO (Answer Engine Optimization) audit on a website. Returns a score 0-100, grade (A-F), breakdown by category (schema, meta, content, technical, AI signals), list of issues found, and prioritized recommendations to improve AI visibility. Use this when you need a comprehensive analysis of why a business isn't appearing in AI assistant answers.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL of the website to audit (e.g. 'https://example.com' or 'example.com')"
        }
      },
      required: ["url"]
    }
  },
  {
    name: "get_aeo_score",
    description: "Get a quick AEO score for a website without the full breakdown. Returns the numeric score (0-100) and letter grade (A-F). Use this for a quick visibility check before deciding whether a full audit is needed.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL of the website to check"
        }
      },
      required: ["url"]
    }
  },
  {
    name: "check_ai_readiness",
    description: "Check whether a website is properly configured for AI crawler access. Checks robots.txt for AI bot blocks, presence of llms.txt, schema markup, and other signals that affect whether ChatGPT, Claude, Perplexity and other AI assistants can read and cite the site. Returns a readiness summary with specific blockers.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL of the website to check"
        }
      },
      required: ["url"]
    }
  }
];

// ─── MCP Handler ─────────────────────────────────────────────────────────────

async function handleMcp(req, env) {
  let body;
  try {
    body = await req.json();
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== "2.0") {
    return jsonRpcError(id, -32600, "Invalid Request: jsonrpc must be '2.0'");
  }

  // Handle notifications (no response expected)
  if (method?.startsWith?.("notifications/")) {
    return new Response(null, { status: 202, headers: CORS_HEADERS });
  }

  switch (method) {
    case "initialize": {
      return jsonRpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
          description: "AEO (Answer Engine Optimization) audit server by Synlig Digital. Audits websites for AI visibility in ChatGPT, Claude, Perplexity, and other AI assistants.",
        },
        instructions: "AEO Audit server by Synlig Digital. Use analyze_aeo(url) to check AI visibility scores for any website. Free to use. Learn more at synligdigital.no"
      });
    }

    case "ping": {
      return jsonRpcOk(id, {});
    }

    case "tools/list": {
      return jsonRpcOk(id, { tools: TOOLS });
    }

    case "resources/list": {
      return jsonRpcOk(id, { resources: [] });
    }

    case "prompts/list": {
      return jsonRpcOk(id, { prompts: [] });
    }

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (!toolName) return jsonRpcError(id, -32602, "Invalid params: missing 'name'");

      const url = args.url;
      if (!url) {
        return jsonRpcOk(id, {
          content: [{ type: "text", text: "Error: 'url' parameter is required" }],
          isError: true
        });
      }

      // Validate URL
      let parsedUrl;
      try {
        parsedUrl = new URL(url.startsWith("http") ? url : "https://" + url);
      } catch {
        return jsonRpcOk(id, {
          content: [{ type: "text", text: `Error: Invalid URL '${url}'` }],
          isError: true
        });
      }

      const t0 = Date.now();
      const referrer = req.headers.get("referer") || req.headers.get("origin") || "direct";
      const userAgent = req.headers.get("user-agent") || "";

      const logEvent = (toolName, result) => {
        try {
          env.AEO_ANALYTICS?.writeDataPoint({
            blobs: [
              toolName,
              parsedUrl.hostname,
              referrer.slice(0, 128),
              userAgent.slice(0, 128),
              result?.grade || "",
            ],
            doubles: [
              result?.totalScore ?? -1,
              Date.now() - t0,
            ],
            indexes: [toolName],
          });
        } catch { /* analytics failure must not break the response */ }
      };

      try {
        if (toolName === "analyze_aeo") {
          const result = await runAudit(parsedUrl.href);
          const summary = formatAuditSummary(result);
          logEvent("analyze_aeo", result);
          return jsonRpcOk(id, {
            content: [
              { type: "text", text: summary },
              { type: "text", text: JSON.stringify(result, null, 2) }
            ]
          });
        }

        if (toolName === "get_aeo_score") {
          const result = await runAudit(parsedUrl.href);
          const text = `AEO Score for ${result.url}: ${result.totalScore}/100 (Grade: ${result.grade})\n\nTop 3 issues:\n${result.issues.slice(0, 3).map((i, n) => `${n+1}. ${i}`).join('\n')}\n\nFor full audit, use analyze_aeo tool.\nLearn more: synligdigital.no`;
          logEvent("get_aeo_score", result);
          return jsonRpcOk(id, {
            content: [{ type: "text", text }]
          });
        }

        if (toolName === "check_ai_readiness") {
          const result = await runAudit(parsedUrl.href);
          const tech = result.breakdown.technical;
          const ai = result.breakdown.aiSignals;
          const issues = [];
          if (tech.details.blocksGpt) issues.push("❌ Blocks GPTBot (ChatGPT cannot index this site)");
          if (tech.details.blocksClaude) issues.push("❌ Blocks ClaudeBot (Claude cannot index this site)");
          if (!tech.details.hasLlmsTxt) issues.push("⚠️ No /llms.txt file found");
          if (!tech.details.hasSitemap) issues.push("⚠️ No sitemap.xml referenced");
          if (!ai.details.hasSpeakable) issues.push("⚠️ No Speakable schema (voice assistants)");
          if (result.breakdown.schema.details.schemaBlockCount === 0) issues.push("❌ No JSON-LD structured data");

          const readinessScore = result.breakdown.technical.score + result.breakdown.aiSignals.score;
          const maxReadiness = result.breakdown.technical.max + result.breakdown.aiSignals.max;

          const text = `AI Readiness for ${result.url}:\nScore: ${readinessScore}/${maxReadiness}\n\n${issues.length === 0 ? "✅ Site is well-configured for AI crawlers" : "Issues found:\n" + issues.join('\n')}\n\nTechnical score: ${tech.score}/${tech.max}\nAI signals score: ${ai.score}/${ai.max}\n\nFull report: synligdigital.no`;
          logEvent("check_ai_readiness", result);
          return jsonRpcOk(id, {
            content: [{ type: "text", text }]
          });
        }

        return jsonRpcOk(id, {
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
          isError: true
        });

      } catch (e) {
        try {
          env.AEO_ANALYTICS?.writeDataPoint({
            blobs: [toolName, parsedUrl.hostname, referrer.slice(0, 128), userAgent.slice(0, 128), "error"],
            doubles: [-1, Date.now() - t0],
            indexes: [toolName],
          });
        } catch { /* ignore */ }
        return jsonRpcOk(id, {
          content: [{ type: "text", text: `Audit failed: ${e.message}` }],
          isError: true
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Format Helpers ──────────────────────────────────────────────────────────

function formatAuditSummary(r) {
  const grade_emoji = { A: "🟢", B: "🟡", C: "🟠", D: "🔴", E: "🔴", F: "⛔" };
  const emoji = grade_emoji[r.grade] || "⚪";
  let out = `${emoji} AEO Score: ${r.totalScore}/100 — Grade ${r.grade}\n`;
  out += `URL: ${r.url}\n`;
  out += `Audited: ${r.auditedAt}\n\n`;
  out += `BREAKDOWN:\n`;
  out += `  Structured Data: ${r.breakdown.schema.score}/${r.breakdown.schema.max}\n`;
  out += `  Meta Tags: ${r.breakdown.meta.score}/${r.breakdown.meta.max}\n`;
  out += `  Content Quality: ${r.breakdown.content.score}/${r.breakdown.content.max}\n`;
  out += `  Technical: ${r.breakdown.technical.score}/${r.breakdown.technical.max}\n`;
  out += `  AI Signals: ${r.breakdown.aiSignals.score}/${r.breakdown.aiSignals.max}\n\n`;
  if (r.issues.length > 0) {
    out += `ISSUES (${r.issues.length}):\n`;
    r.issues.slice(0, 5).forEach((i, n) => { out += `  ${n+1}. ${i}\n`; });
    if (r.issues.length > 5) out += `  ... and ${r.issues.length - 5} more\n`;
    out += "\n";
  }
  if (r.recommendations.length > 0) {
    out += `TOP RECOMMENDATIONS:\n`;
    r.recommendations.slice(0, 5).forEach((rec, n) => { out += `  ${n+1}. ${rec}\n`; });
    if (r.recommendations.length > 5) out += `  ... and ${r.recommendations.length - 5} more\n`;
    out += "\n";
  }
  out += `Professional AEO implementation: synligdigital.no`;
  return out;
}

function jsonRpcOk(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function jsonRpcError(id, code, message) {
  return new Response(JSON.stringify({
    jsonrpc: "2.0", id,
    error: { code, message }
  }), {
    status: 200,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

// ─── Main Worker ─────────────────────────────────────────────────────────────

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health check
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(JSON.stringify({
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        protocol: "MCP Streamable HTTP",
        protocolVersion: PROTOCOL_VERSION,
        endpoint: "/mcp",
        tools: TOOLS.map(t => t.name),
        learnMore: "https://synligdigital.no",
        agentCard: "/.well-known/agent-card.json",
        mcpServerCard: "/.well-known/mcp/server-card.json"
      }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // MCP server card (Smithery registry metadata)
    if (url.pathname === "/.well-known/mcp/server-card.json") {
      return new Response(JSON.stringify({
        serverInfo: {
          name: "AEO Audit by Synlig Digital",
          version: SERVER_VERSION,
          description: "AEO (Answer Engine Optimization) audit server by Synlig Digital. Audits websites for AI visibility in ChatGPT, Claude, Perplexity, and other AI assistants. Three tools: analyze_aeo, get_aeo_score, check_ai_readiness."
        },
        tools: TOOLS,
        resources: [],
        prompts: []
      }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // Agent card for A2A/ERC-8004
    if (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/.well-known/agent.json") {
      return new Response(JSON.stringify({
        name: "AEO Audit",
        description: "AI visibility auditor for business websites. Checks schema markup, meta tags, content quality, technical setup, and AI crawler access. Returns score 0-100 with prioritized recommendations.",
        url: `https://${url.hostname}`,
        version: SERVER_VERSION,
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ["application/json"],
        defaultOutputModes: ["application/json"],
        skills: [
          { id: "analyze_aeo", name: "Analyze AEO", description: "Full AEO audit — score, breakdown, recommendations", tags: ["aeo", "seo", "audit"] },
          { id: "get_aeo_score", name: "Get AEO Score", description: "Quick score check", tags: ["aeo", "score"] },
          { id: "check_ai_readiness", name: "Check AI Readiness", description: "AI crawler access audit", tags: ["ai", "crawlers", "llms.txt"] }
        ],
        contact: "hei@synligdigital.no",
        provider: { organization: "Synlig Digital", url: "https://synligdigital.no" }
      }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // ERC-8004 agent registration metadata
    if (url.pathname === "/.well-known/agent-registration.json") {
      return new Response(JSON.stringify({
        type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
        name: "AEO Audit by Synlig",
        description: "AI visibility auditor for business websites. Analyzes schema markup, meta tags, content quality, technical setup, and AI crawler access. Returns score 0-100 with prioritized recommendations. Operated by Synlig (synligdigital.no), Stavanger, Norway.",
        image: "https://synligdigital.no/logo.png",
        services: [
          {
            name: "MCP",
            endpoint: `https://${url.hostname}/mcp`,
            version: "1.0.0",
            protocol: "MCP Streamable HTTP"
          },
          {
            name: "A2A",
            endpoint: `https://${url.hostname}/.well-known/agent-card.json`,
            version: "0.3.0",
            a2aSkills: [
              { id: "analyze_aeo", name: "AEO Audit", tags: ["aeo", "seo", "audit", "schema", "ai-visibility"] },
              { id: "get_aeo_score", name: "AEO Score Check", tags: ["aeo", "score"] },
              { id: "check_ai_readiness", name: "AI Readiness Check", tags: ["ai", "crawlers", "llms.txt"] }
            ]
          },
          {
            name: "web",
            endpoint: "https://synligdigital.no"
          }
        ],
        registrations: [
          { chain: "eip155:8453", address: "0x90EE1EbcCFA2021711C595E1410e22401570B4AC" }
        ]
      }), {
        headers: { "Content-Type": "application/json", ...CORS_HEADERS }
      });
    }

    // REST audit endpoint — GET /audit?url=example.com
    if (url.pathname === "/audit") {
      if (req.method !== "GET") {
        return new Response(JSON.stringify({ error: "Use GET /audit?url=example.com" }), {
          status: 405,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return new Response(JSON.stringify({ error: "Missing ?url= parameter", example: "/audit?url=example.com" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl.startsWith("http") ? targetUrl : `https://${targetUrl}`);
      } catch (e) {
        return new Response(JSON.stringify({ error: "Invalid URL", url: targetUrl }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }
      const t0 = Date.now();
      const referer = req.headers.get("referer") || req.headers.get("origin") || "direct";
      const ua = req.headers.get("user-agent") || "";
      try {
        const result = await runAudit(parsedUrl.href);
        // Log REST audit call to Analytics Engine
        try {
          env.AEO_ANALYTICS?.writeDataPoint({
            blobs: ["rest_audit", parsedUrl.hostname, referer.slice(0, 128), ua.slice(0, 128), result.grade],
            doubles: [result.totalScore, Date.now() - t0],
            indexes: ["rest_audit"],
          });
        } catch { /* ignore */ }
        // Return structured JSON for agent consumption
        return new Response(JSON.stringify({
          url: result.url,
          score: result.totalScore,
          grade: result.grade,
          components: {
            schema: { score: result.breakdown.schema.score, max: result.breakdown.schema.max },
            meta: { score: result.breakdown.meta.score, max: result.breakdown.meta.max },
            content: { score: result.breakdown.content.score, max: result.breakdown.content.max },
            technical: { score: result.breakdown.technical.score, max: result.breakdown.technical.max },
            aiSignals: { score: result.breakdown.aiSignals.score, max: result.breakdown.aiSignals.max }
          },
          issues: result.issues || [],
          recommendations: result.recommendations || [],
          summary: formatAuditSummary(result),
          timestamp: result.auditedAt,
          learnMore: "https://synligdigital.no"
        }), {
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: `Audit failed: ${e.message}`, url: parsedUrl.href }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }
    }

    // MCP endpoint
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "MCP endpoint requires POST" }), {
          status: 405,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS }
        });
      }
      return handleMcp(req, env);
    }

    return new Response(JSON.stringify({
      error: "Not found",
      routes: { "/": "Server info", "/health": "Health check", "/audit": "REST audit endpoint (GET ?url=)", "/mcp": "MCP endpoint (POST)", "/.well-known/agent-card.json": "A2A agent card" }
    }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS }
    });
  }
};
