// api/import-recipe.js
//
// Fetches a recipe URL server-side (avoids CORS, which blocks this from
// working directly in the browser) and pulls out structured recipe data
// most cooking sites embed as schema.org JSON-LD — the same mechanism
// Google uses to show recipe cards in search results.
//
// This is a best-effort scrape: sites that don't embed this structured
// data (or format it unusually) simply won't import cleanly, and the user
// falls back to typing the recipe in by hand.

const SUPABASE_URL = "https://cyxnxoeerlxanjltxhdp.supabase.co";
const SUPABASE_KEY = "sb_publishable_4jQAFzZO52uLigenwuJ9Ng_iVxVgXHm";

async function requireLoggedInUser(token) {
  if (!token) return null;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return res.json();
}

function flattenInstructions(instr) {
  if (!instr) return "";
  if (typeof instr === "string") return instr.trim();
  if (Array.isArray(instr)) {
    return instr
      .map((step) => {
        if (typeof step === "string") return step.trim();
        if (step.itemListElement) return flattenInstructions(step.itemListElement);
        return (step.text || step.name || "").trim();
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractImage(img) {
  if (!img) return "";
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return extractImage(img[0]);
  if (img.url) return img.url;
  return "";
}

function parseIsoDuration(duration) {
  if (!duration || typeof duration !== "string") return null;
  const match = /P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?/.exec(duration);
  if (!match) return null;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

function normalizeRecipe(item) {
  const ingredients = Array.isArray(item.recipeIngredient)
    ? item.recipeIngredient
    : item.recipeIngredient
    ? [item.recipeIngredient]
    : [];
  return {
    name: (item.name || "").trim(),
    ingredients: ingredients.map((i) => String(i).trim()).filter(Boolean),
    instructions: flattenInstructions(item.recipeInstructions),
    timeMinutes: parseIsoDuration(item.totalTime || item.cookTime || item.prepTime),
    photoUrl: extractImage(item.image),
  };
}

function extractRecipeFromHtml(html) {
  const scriptMatches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scriptMatches) {
    let json;
    try {
      json = JSON.parse(m[1].trim());
    } catch {
      continue; // some pages embed slightly invalid JSON — skip and keep looking
    }
    const candidates = Array.isArray(json) ? json : json["@graph"] ? json["@graph"] : [json];
    for (const item of candidates) {
      const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
      if (types.some((t) => (t || "").toLowerCase() === "recipe")) {
        return normalizeRecipe(item);
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization || "";
  const caller = await requireLoggedInUser(authHeader.replace("Bearer ", "").trim());
  if (!caller) {
    return res.status(401).json({ error: "You must be signed in to import a recipe." });
  }

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "A URL is required." });

  try {
    const pageRes = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!pageRes.ok) {
      throw new Error(
        `That site returned an error (${pageRes.status}) — some sites block automatic requests like this one. Try adding the recipe manually instead.`
      );
    }
    const html = await pageRes.text();
    const recipe = extractRecipeFromHtml(html);
    if (!recipe || !recipe.name) {
      throw new Error("Couldn't find recipe details on that page — try adding it manually instead.");
    }
    return res.status(200).json({ recipe });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}