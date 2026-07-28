import { useState, useEffect, useMemo, useRef } from "react";

/*
  DINNER PLANNER — a two-week family dinner planner.

  Data is stored in Supabase (Postgres) via its auto-generated REST API,
  called directly with fetch() since the Supabase JS SDK isn't available
  in this environment. Two tables:
  - recipes              (id, name, cuisine, protein, time_minutes,
                           ingredients, instructions, source_url, rating, tags)
  - calendar_assignments (date, recipe_id)

  Everyone who opens this app with this same Supabase project hits the
  same database, so it's shared across the whole family by design.
*/

// ---------- Supabase config ----------

const SUPABASE_URL = "https://cyxnxoeerlxanjltxhdp.supabase.co";
const SUPABASE_KEY = "sb_publishable_4jQAFzZO52uLigenwuJ9Ng_iVxVgXHm";

// Only this account can see/use the settings (user management) panel.
// Enforced here in the UI AND server-side in api/manage-users.js — the UI
// check alone wouldn't stop someone from calling that endpoint directly.
const ADMIN_EMAIL = "dklancnik@gmail.com";
const REST = `${SUPABASE_URL}/rest/v1`;
const AUTH = `${SUPABASE_URL}/auth/v1`;

// Kept outside React state so every fetch helper below can read the latest
// token without needing it threaded through as an argument. Updated by
// the login/logout handlers in the main app component.
let currentAccessToken = null;

function authHeaders() {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${currentAccessToken || SUPABASE_KEY}`,
    "Content-Type": "application/json",
  };
}

// ---------- auth ----------

async function apiLogin(email, password) {
  const res = await fetch(`${AUTH}/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || "Couldn't sign in — check the email and password.");
  }
  return data; // { access_token, refresh_token, user, ... }
}

async function apiRefreshSession(refreshToken) {
  const res = await fetch(`${AUTH}/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error_description || data.msg || "Session expired — please sign in again.");
  }
  return data;
}

async function apiLogout(accessToken) {
  try {
    await fetch(`${AUTH}/logout`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    /* best-effort — clearing local state below is what actually matters */
  }
}

// "Keep me signed in" persists only the refresh token (not the access token
// or password) to localStorage. Skipped entirely inside the Claude artifact
// preview, where localStorage isn't supported.
const SESSION_STORAGE_KEY = "dinnerPlannerSession";

function saveRememberedSession(refreshToken) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ refresh_token: refreshToken }));
  } catch {
    /* private-browsing or storage disabled — remembering just won't persist */
  }
}

function clearRememberedSession() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}

function loadRememberedSession() {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// ---------- user management (routed through /api/manage-users so the
// Supabase service-role key never has to live in the browser) ----------

async function callManageUsers(action, payload = {}) {
  const res = await fetch("/api/manage-users", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${currentAccessToken || ""}`,
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const apiListUsers = () => callManageUsers("list").then((d) => d.users);
const apiCreateUser = (email, password) => callManageUsers("create", { email, password });
const apiUpdateUserEmail = (id, email) => callManageUsers("updateEmail", { id, email });
const apiUpdateUserPassword = (id, password) => callManageUsers("updatePassword", { id, password });
const apiDeleteUser = (id) => callManageUsers("delete", { id });

function toDbRecipe(r) {
  return {
    id: r.id,
    name: r.name,
    cuisine: r.cuisine,
    protein: r.protein,
    time_minutes: r.timeMinutes,
    ingredients: r.ingredients,
    instructions: r.instructions,
    source_url: r.sourceUrl,
    rating: r.rating,
    tags: r.tags || [],
    photo_url: r.photoUrl || null,
  };
}

function fromDbRecipe(row) {
  return {
    id: row.id,
    name: row.name,
    cuisine: row.cuisine,
    protein: row.protein,
    timeMinutes: row.time_minutes,
    ingredients: row.ingredients || "",
    instructions: row.instructions || "",
    sourceUrl: row.source_url || "",
    rating: row.rating || 0,
    tags: row.tags || [],
    photoUrl: row.photo_url || "",
  };
}

const RECIPE_PHOTO_BUCKET = "recipe-photos";

// Uploads a photo to Supabase Storage and returns its public URL.
async function apiUploadRecipePhoto(file, recipeId) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
  const path = `${recipeId}-${Date.now()}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${RECIPE_PHOTO_BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${currentAccessToken || SUPABASE_KEY}`,
      "Content-Type": file.type || "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Couldn't upload photo (${res.status})`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${RECIPE_PHOTO_BUCKET}/${path}`;
}

// Deletes a photo from Storage given its public URL. Best-effort: a recipe
// should still get deleted even if this fails for some reason.
async function apiDeleteRecipePhoto(photoUrl) {
  if (!photoUrl) return;
  const marker = `/storage/v1/object/public/${RECIPE_PHOTO_BUCKET}/`;
  const idx = photoUrl.indexOf(marker);
  if (idx === -1) return; // not a photo stored in our bucket, nothing to clean up
  const path = photoUrl.slice(idx + marker.length);
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${RECIPE_PHOTO_BUCKET}/${path}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${currentAccessToken || SUPABASE_KEY}`,
      },
    });
    if (!res.ok) console.error("Couldn't delete recipe photo:", res.status);
  } catch (err) {
    console.error("Couldn't delete recipe photo:", err);
  }
}

async function apiListRecipes() {
  const res = await fetch(`${REST}/recipes?select=*`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Couldn't load recipes (${res.status})`);
  const rows = await res.json();
  return rows.map(fromDbRecipe);
}

async function apiSeedRecipes(recipeList) {
  const res = await fetch(`${REST}/recipes`, {
    method: "POST",
    headers: { ...authHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(recipeList.map(toDbRecipe)),
  });
  if (!res.ok) throw new Error(`Couldn't seed starter recipes (${res.status})`);
  const rows = await res.json();
  return rows.map(fromDbRecipe);
}

async function apiInsertRecipe(recipe) {
  const res = await fetch(`${REST}/recipes`, {
    method: "POST",
    headers: { ...authHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(toDbRecipe(recipe)),
  });
  if (!res.ok) throw new Error(`Couldn't add recipe (${res.status})`);
  const [row] = await res.json();
  return fromDbRecipe(row);
}

async function apiUpdateRecipe(recipe) {
  const res = await fetch(`${REST}/recipes?id=eq.${encodeURIComponent(recipe.id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(toDbRecipe(recipe)),
  });
  if (!res.ok) throw new Error(`Couldn't save recipe (${res.status})`);
  const [row] = await res.json();
  return fromDbRecipe(row);
}

async function apiUpdateRating(id, rating) {
  const res = await fetch(`${REST}/recipes?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...authHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({ rating }),
  });
  if (!res.ok) throw new Error(`Couldn't save rating (${res.status})`);
  const [row] = await res.json();
  return fromDbRecipe(row);
}

async function apiDeleteRecipe(id) {
  const res = await fetch(`${REST}/recipes?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Couldn't delete recipe (${res.status})`);
}

async function apiListCalendar() {
  const res = await fetch(`${REST}/calendar_assignments?select=*&order=created_at.asc`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Couldn't load calendar (${res.status})`);
  const rows = await res.json();
  const map = {};
  rows.forEach((row) => {
    if (!map[row.date]) map[row.date] = [];
    map[row.date].push({ id: row.id, recipeId: row.recipe_id });
  });
  return map;
}

// Adds a recipe to a day without disturbing anything else already there.
async function apiAddAssignment(dateStr, recipeId) {
  const id = "a" + Date.now() + Math.random().toString(36).slice(2, 7);
  const res = await fetch(`${REST}/calendar_assignments`, {
    method: "POST",
    headers: { ...authHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({ id, date: dateStr, recipe_id: recipeId }),
  });
  if (!res.ok) throw new Error(`Couldn't assign recipe (${res.status})`);
  const [row] = await res.json();
  return { id: row.id, recipeId: row.recipe_id };
}

// Moves one specific assignment to a different day (used by drag-and-drop).
async function apiMoveAssignment(assignmentId, newDateStr) {
  const res = await fetch(`${REST}/calendar_assignments?id=eq.${encodeURIComponent(assignmentId)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ date: newDateStr }),
  });
  if (!res.ok) throw new Error(`Couldn't move that recipe (${res.status})`);
}

// Removes one specific assignment (not the whole day).
async function apiRemoveAssignment(assignmentId) {
  const res = await fetch(`${REST}/calendar_assignments?id=eq.${encodeURIComponent(assignmentId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Couldn't remove that day's recipe (${res.status})`);
}

// Used when a recipe is deleted outright, to clear it off every day it was on.
async function apiDeleteAssignmentsByRecipe(recipeId) {
  const res = await fetch(`${REST}/calendar_assignments?recipe_id=eq.${encodeURIComponent(recipeId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Couldn't clean up the calendar (${res.status})`);
}

// ---------- shopping list ----------

async function apiListShoppingItems() {
  const res = await fetch(`${REST}/shopping_list_items?select=*&order=created_at.asc`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Couldn't load the shopping list (${res.status})`);
  const rows = await res.json();
  return rows.map((row) => ({
    id: row.id,
    text: row.text,
    checked: row.checked,
    sources: row.sources || [],
    haveAtHome: row.have_at_home || false,
  }));
}

async function apiInsertShoppingItems(items) {
  if (items.length === 0) return [];
  const dbItems = items.map((i) => ({
    id: i.id,
    text: i.text,
    checked: i.checked,
    sources: i.sources || [],
    have_at_home: i.haveAtHome || false,
  }));
  const res = await fetch(`${REST}/shopping_list_items`, {
    method: "POST",
    headers: { ...authHeaders(), Prefer: "return=representation" },
    body: JSON.stringify(dbItems),
  });
  if (!res.ok) throw new Error(`Couldn't add items (${res.status})`);
  return res.json();
}

async function apiUpdateShoppingItem(id, checked) {
  const res = await fetch(`${REST}/shopping_list_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ checked }),
  });
  if (!res.ok) throw new Error(`Couldn't update that item (${res.status})`);
}

async function apiUpdateShoppingItemSources(id, sources) {
  const res = await fetch(`${REST}/shopping_list_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ sources }),
  });
  if (!res.ok) throw new Error(`Couldn't update that item (${res.status})`);
}

async function apiUpdateShoppingItemHaveAtHome(id, haveAtHome) {
  const res = await fetch(`${REST}/shopping_list_items?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: authHeaders(),
    body: JSON.stringify({ have_at_home: haveAtHome }),
  });
  if (!res.ok) throw new Error(`Couldn't update that item (${res.status})`);
}

async function apiDeleteShoppingItem(id) {
  const res = await fetch(`${REST}/shopping_list_items?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Couldn't remove that item (${res.status})`);
}

async function apiDeleteShoppingItems(ids) {
  if (ids.length === 0) return;
  const res = await fetch(`${REST}/shopping_list_items?id=in.(${ids.map(encodeURIComponent).join(",")})`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Couldn't clear those items (${res.status})`);
}

// ---------- constants ----------

const CUISINES = ["Italian", "Mexican", "American", "Asian", "Mediterranean", "Indian", "Other"];
const PROTEINS = ["Chicken", "Beef", "Pork", "Fish / Seafood", "Vegetarian", "Other"];
const TIME_BUCKETS = [
  { label: "20 min or less", max: 20 },
  { label: "About 30 min", max: 35 },
  { label: "45 min+", max: 999 },
];

const SEED_RECIPES = [
  {
    id: "r1",
    name: "Weeknight Chicken Tacos",
    cuisine: "Mexican",
    protein: "Chicken",
    timeMinutes: 25,
    ingredients: "Chicken thighs, taco seasoning, tortillas, lime, cilantro, onion, cotija cheese",
    instructions: "Season and sear chicken, slice, warm tortillas, build tacos with toppings.",
    sourceUrl: "",
    rating: 5,
    tags: ["kid-friendly", "weeknight"],
  },
  {
    id: "r2",
    name: "Sheet Pan Salmon & Veggies",
    cuisine: "Mediterranean",
    protein: "Fish / Seafood",
    timeMinutes: 30,
    ingredients: "Salmon fillets, zucchini, cherry tomatoes, olive oil, lemon, oregano",
    instructions: "Toss veggies in oil, roast 10 min, add salmon on top, roast 12-15 min more.",
    sourceUrl: "",
    rating: 4,
    tags: ["one-pan", "healthy"],
  },
  {
    id: "r3",
    name: "Sunday Beef Bolognese",
    cuisine: "Italian",
    protein: "Beef",
    timeMinutes: 60,
    ingredients: "Ground beef, crushed tomatoes, carrot, celery, onion, garlic, pasta, parmesan",
    instructions: "Soffritto, brown beef, add tomatoes, simmer 45 min, toss with pasta.",
    sourceUrl: "",
    rating: 5,
    tags: ["freezer-friendly", "sunday project"],
  },
  {
    id: "r4",
    name: "Veggie Fried Rice",
    cuisine: "Asian",
    protein: "Vegetarian",
    timeMinutes: 20,
    ingredients: "Day-old rice, egg, frozen peas & carrots, scallion, soy sauce, sesame oil",
    instructions: "Scramble egg, set aside, stir-fry veg, add rice, egg, and sauce, toss to combine.",
    sourceUrl: "",
    rating: 4,
    tags: ["uses leftovers", "weeknight"],
  },
  {
    id: "r5",
    name: "Butter Chicken",
    cuisine: "Indian",
    protein: "Chicken",
    timeMinutes: 45,
    ingredients: "Chicken thighs, yogurt, tomato puree, butter, cream, garam masala, garlic, ginger",
    instructions: "Marinate chicken, sear, simmer in spiced tomato-butter sauce with cream.",
    sourceUrl: "",
    rating: 5,
    tags: ["crowd-pleaser"],
  },
  {
    id: "r6",
    name: "Classic Cheeseburgers",
    cuisine: "American",
    protein: "Beef",
    timeMinutes: 20,
    ingredients: "Ground beef, buns, cheddar, lettuce, tomato, onion, pickles, condiments",
    instructions: "Form patties, season, grill or pan-sear, melt cheese, build burgers.",
    sourceUrl: "",
    rating: 4,
    tags: ["kid-friendly", "grill night"],
  },
];

const EMPTY_RECIPE_FORM = {
  name: "",
  cuisine: CUISINES[0],
  protein: PROTEINS[0],
  timeMinutes: "",
  ingredients: "",
  instructions: "",
  sourceUrl: "",
  tags: [],
  rating: 0,
  photoUrl: "",
};

// ---------- helpers ----------

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function fmtDay(d) {
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function fmtDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function nextTwoWeeks() {
  const days = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const dayOfWeek = start.getDay(); // 0 = Sunday ... 6 = Saturday
  const daysSinceMonday = (dayOfWeek + 6) % 7; // Monday = 0 ... Sunday = 6
  start.setDate(start.getDate() - daysSinceMonday);
  for (let i = 0; i < 14; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(d);
  }
  return days;
}

function timeLabel(minutes) {
  if (minutes == null) return "time not set";
  const bucket = TIME_BUCKETS.find((b) => minutes <= b.max);
  return bucket ? bucket.label : `${minutes} min`;
}

// ---------- shopping list helpers ----------

// Splits a recipe's free-text ingredients field into individual lines.
function parseIngredientLines(text) {
  return (text || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim().replace(/^[-*•]\s+/, ""))
    .filter(Boolean);
}

// Auto-continues a "- " bullet onto the next line when Enter is pressed,
// and ends the list if Enter is pressed on an already-empty bullet line.
function handleBulletKeyDown(e, value, setValue) {
  if (e.key !== "Enter") return;
  const ta = e.target;
  const pos = ta.selectionStart;
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  const currentLine = value.slice(lineStart, pos);
  const match = currentLine.match(/^(\s*)[-*•]\s+/);
  if (!match) return;
  e.preventDefault();
  const [prefix, indent] = match;
  const restOfLine = currentLine.slice(prefix.length);
  let newValue, newPos;
  if (restOfLine.trim() === "") {
    // Empty bullet — remove it instead of continuing the list forever.
    newValue = value.slice(0, lineStart) + value.slice(pos);
    newPos = lineStart;
  } else {
    const insertion = "\n" + indent + "- ";
    newValue = value.slice(0, pos) + insertion + value.slice(pos);
    newPos = pos + insertion.length;
  }
  setValue(newValue);
  requestAnimationFrame(() => ta.setSelectionRange(newPos, newPos));
}

const INGREDIENT_UNIT_WORDS = new Set([
  "cup", "cups", "tbsp", "tablespoon", "tablespoons", "tsp", "teaspoon", "teaspoons",
  "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "clove", "cloves",
  "can", "cans", "g", "kg", "ml", "l", "pinch", "slice", "slices",
  "large", "medium", "small", "of",
]);

// A rough normalized key for spotting duplicate ingredients across recipes,
// e.g. "2 cups flour" and "1 cup all-purpose flour" both key close to "flour".
// This is intentionally approximate, not a precise unit-aware merge.
function normalizeIngredientKey(line) {
  let s = line.toLowerCase().replace(/^[\d\s./-]+/, "");
  const words = s.split(/\s+/).filter(Boolean);
  while (words.length && INGREDIENT_UNIT_WORDS.has(words[0].replace(/[,.]$/, ""))) {
    words.shift();
  }
  s = words.join(" ").replace(/[.,]+$/, "").trim();
  if (s.endsWith("es")) s = s.slice(0, -2);
  else if (s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s || line.toLowerCase().trim();
}

function newShoppingItemId() {
  return "s" + Date.now() + Math.random().toString(36).slice(2, 7);
}

// ---------- grocery section grouping ----------
// Approximate, keyword-based — there's no way to know for certain that
// "onion" is produce from free text alone, so this is a best guess, in the
// order most stores are laid out, not a precise classification.

const GROCERY_SECTIONS = ["Produce", "Dairy & Eggs", "Meat & Seafood", "Bakery", "Frozen", "Pantry", "Other"];

const GROCERY_KEYWORDS = {
  Produce: [
    "onion", "garlic", "tomato", "lettuce", "spinach", "kale", "potato", "carrot", "celery",
    "bell pepper", "cucumber", "zucchini", "broccoli", "cauliflower", "mushroom", "lemon",
    "lime", "apple", "banana", "avocado", "cilantro", "parsley", "basil", "mint", "dill",
    "rosemary", "thyme", "scallion", "green onion", "ginger", "corn", "squash", "cabbage",
    "berries", "strawberr", "grape", "orange", "peach", "pear", "melon",
  ],
  "Dairy & Eggs": [
    "milk", "cheese", "butter", "yogurt", "cream", "sour cream", "egg", "parmesan",
    "mozzarella", "cheddar", "cotija", "half and half", "cream cheese", "cottage cheese",
  ],
  "Meat & Seafood": [
    "chicken", "beef", "pork", "turkey", "salmon", "shrimp", "fish", "bacon", "sausage",
    "steak", "tilapia", "cod", "ground beef", "ground turkey", "lamb", "ham",
  ],
  Bakery: ["bread", "bun", "tortilla", "bagel", "roll", "pita", "naan", "baguette", "english muffin"],
  Frozen: ["frozen", "ice cream", "frozen pizza", "frozen peas", "popsicle"],
  Pantry: [
    "flour", "sugar", "rice", "pasta", "oil", "vinegar", "canned", "can of", "beans", "broth",
    "stock", "cumin", "paprika", "garam masala", "cinnamon", "salt", "pepper", "soy sauce",
    "sesame oil", "tomato paste", "crushed tomatoes", "tomato puree", "panko", "breadcrumb",
    "honey", "peanut butter", "oats", "cereal", "cracker", "seasoning", "spice", "sauce",
    "ketchup", "mustard", "mayo", "syrup", "stock", "bouillon", "tortilla chip", "nut",
  ],
};

function guessGrocerySection(text) {
  const lower = text.toLowerCase();
  for (const section of GROCERY_SECTIONS) {
    const words = GROCERY_KEYWORDS[section];
    if (words && words.some((w) => lower.includes(w))) return section;
  }
  return "Other";
}

// Adds https:// if someone pastes a bare domain, so the link still opens correctly.
function normalizeUrl(url) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// ---------- small shared components ----------

function Stars({ value, onChange, size = 16 }) {
  return (
    <div className="sb-stars" style={{ fontSize: size }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={"sb-star" + (n <= value ? " sb-star-filled" : "")}
          onClick={
            onChange
              ? (e) => {
                  e.stopPropagation();
                  onChange(n);
                }
              : undefined
          }
        >
          ★
        </span>
      ))}
    </div>
  );
}

function Chip({ label, active, onClick }) {
  return (
    <button type="button" className={"sb-chip" + (active ? " sb-chip-active" : "")} onClick={onClick}>
      {label}
    </button>
  );
}

// A recipe index card. `pinned` renders the calendar version (rotated, with a tack).
// `onDragStart(e, recipe)` wires up press-and-hold dragging; `dragging` dims this
// exact instance while it's the one being picked up.
function RecipeCard({ recipe, pinned, onOpen, onRemove, onDragStart, dragging }) {
  return (
    <div
      className={"sb-card" + (pinned ? " sb-card-pinned" : "") + (dragging ? " sb-card-dragging" : "")}
      onClick={() => onOpen(recipe)}
      onPointerDown={
        pinned && onDragStart
          ? (e) => {
              if (e.target.closest(".sb-card-remove, .sb-star")) return;
              onDragStart(e, recipe);
            }
          : undefined
      }
    >
      {pinned && <div className="sb-tack" />}
      <div className="sb-card-holes">
        <span />
        <span />
      </div>
      <div className="sb-card-body">
        <div className="sb-card-tags">
          <span className="sb-tag">{recipe.cuisine}</span>
          <span className="sb-tag">{recipe.protein}</span>
        </div>
        <div className="sb-card-title-row">
          {recipe.photoUrl && <img src={recipe.photoUrl} alt="" className="sb-card-thumb" />}
          <h4 className="sb-card-title">{recipe.name}</h4>
        </div>
        <div className="sb-card-meta">{timeLabel(recipe.timeMinutes)}</div>
        {recipe.tags && recipe.tags.length > 0 && (
          <div className="sb-card-tags">
            {recipe.tags.map((t) => (
              <span key={t} className="sb-tag sb-tag-custom">
                {t}
              </span>
            ))}
          </div>
        )}
        <Stars value={recipe.rating} />
      </div>
      {pinned && (
        <button
          className="sb-card-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          remove
        </button>
      )}
      {!pinned && onDragStart && (
        <div
          className="sb-card-drag-handle"
          onPointerDown={(e) => onDragStart(e, recipe)}
          aria-label="Drag to a day on the calendar"
          title="Drag to a day"
        >
          ⠿
        </div>
      )}
    </div>
  );
}

function EmptySlot({ onClick, hovered }) {
  return (
    <div className={"sb-slot-empty" + (hovered ? " sb-slot-empty-hover" : "")} onClick={onClick}>
      <div className="sb-slot-plus">+</div>
      <div className="sb-slot-label">add dinner</div>
    </div>
  );
}

// ---------- Add / edit recipe form ----------

function RecipeForm({ initial, onSave, onCancel, onDelete }) {
  const [recipeId] = useState(() => (initial ? initial.id : "r" + Date.now()));
  const [form, setForm] = useState(
    initial
      ? {
          name: initial.name,
          cuisine: initial.cuisine,
          protein: initial.protein,
          timeMinutes: initial.timeMinutes != null ? String(initial.timeMinutes) : "",
          ingredients: initial.ingredients,
          instructions: initial.instructions,
          sourceUrl: initial.sourceUrl || "",
          tags: initial.tags || [],
          rating: initial.rating || 0,
          photoUrl: initial.photoUrl || "",
        }
      : EMPTY_RECIPE_FORM
  );
  const [tagInput, setTagInput] = useState("");
  const [recipeTab, setRecipeTab] = useState("ingredients"); // "ingredients" | "instructions"
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [importNote, setImportNote] = useState("");

  const update = (field) => (e) => setForm({ ...form, [field]: e.target.value });
  const isValid = !!form.name.trim();

  const addTag = () => {
    const clean = tagInput.trim().toLowerCase();
    if (!clean) return;
    if (form.tags.includes(clean)) {
      setTagInput("");
      return;
    }
    setForm({ ...form, tags: [...form.tags, clean] });
    setTagInput("");
  };

  const removeTag = (tag) => {
    setForm({ ...form, tags: form.tags.filter((t) => t !== tag) });
  };

  const handlePhotoChange = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ""; // allow picking the same file again later
    if (!file) return;
    setPhotoError("");
    setPhotoUploading(true);
    try {
      if (isPreviewSandbox) {
        // Storage can't be reached from the chat preview — show it locally instead.
        setForm((f) => ({ ...f, photoUrl: URL.createObjectURL(file) }));
      } else {
        const url = await apiUploadRecipePhoto(file, recipeId);
        setForm((f) => ({ ...f, photoUrl: url }));
      }
    } catch (err) {
      console.error(err);
      setPhotoError(err.message);
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleImport = async () => {
    const url = form.sourceUrl.trim();
    if (!url) return;
    setImportError("");
    setImportNote("");
    if (isPreviewSandbox) {
      setImportError("Importing needs the real deployed app — this preview can't reach outside websites.");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/import-recipe", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentAccessToken || ""}` },
        body: JSON.stringify({ url: normalizeUrl(url) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't import that recipe.");
      const r = data.recipe;
      const importedIngredients =
        r.ingredients && r.ingredients.length
          ? r.ingredients
              .map((i) => `- ${i.replace(/,/g, "").replace(/\s+/g, " ").trim()}`)
              .join("\n")
          : "";
      setForm((f) => ({
        ...f,
        name: f.name.trim() ? f.name : r.name || f.name,
        ingredients: f.ingredients.trim() ? f.ingredients : importedIngredients || f.ingredients,
        instructions: f.instructions.trim() ? f.instructions : r.instructions || f.instructions,
        timeMinutes: f.timeMinutes.trim() ? f.timeMinutes : r.timeMinutes ? String(r.timeMinutes) : f.timeMinutes,
        photoUrl: f.photoUrl ? f.photoUrl : r.photoUrl || f.photoUrl,
      }));
      setImportNote("Imported! Double check everything looks right before saving.");
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  };

  const submit = () => {
    if (!isValid) return;
    onSave({
      id: recipeId,
      name: form.name.trim(),
      cuisine: form.cuisine,
      protein: form.protein,
      timeMinutes: form.timeMinutes.trim() ? Number(form.timeMinutes) : null,
      ingredients: form.ingredients.trim(),
      instructions: form.instructions.trim(),
      sourceUrl: form.sourceUrl.trim(),
      tags: form.tags,
      rating: form.rating,
      photoUrl: form.photoUrl,
    });
  };

  // Closing the card (× or clicking outside) auto-saves any valid changes
  // instead of discarding them. A brand-new recipe with no name yet still
  // just cancels, since there's nothing meaningful to save.
  const handleClose = () => {
    if (isValid) submit();
    else onCancel();
  };

  return (
    <div className="sb-modal-backdrop" onClick={handleClose}>
      <div className="sb-sheet" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="sb-sheet-close" onClick={handleClose} aria-label="Close">
          ×
        </button>
        <h2 className="sb-sheet-title">{initial ? "Edit recipe" : "Add a recipe"}</h2>

        <div className="sb-field sb-field-wide">
          <span>Photo (optional)</span>
          <div className="sb-photo-field">
            {form.photoUrl ? (
              <img src={form.photoUrl} alt="" className="sb-photo-preview" />
            ) : (
              <div className="sb-photo-placeholder">no photo yet</div>
            )}
            <div className="sb-photo-actions">
              <label className="sb-btn-ghost sb-btn-small sb-photo-upload-btn">
                {photoUploading ? "uploading..." : form.photoUrl ? "change photo" : "add photo"}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoChange}
                  disabled={photoUploading}
                  className="sb-visually-hidden"
                />
              </label>
              {form.photoUrl && (
                <button
                  type="button"
                  className="sb-btn-ghost sb-btn-small sb-btn-danger"
                  onClick={() => setForm({ ...form, photoUrl: "" })}
                >
                  remove photo
                </button>
              )}
            </div>
            {photoError && <p className="sb-login-error" style={{ marginTop: 8 }}>{photoError}</p>}
          </div>
        </div>

        <label className="sb-field sb-field-wide">
          <span>Found it online? Paste the link (optional)</span>
          <input value={form.sourceUrl} onChange={update("sourceUrl")} placeholder="https://..." />
          <div className="sb-url-actions">
            {form.sourceUrl.trim() && (
              <button
                type="button"
                className="sb-source-link"
                onClick={() => window.open(normalizeUrl(form.sourceUrl.trim()), "_blank", "noopener,noreferrer")}
              >
                open link ↗
              </button>
            )}
            {form.sourceUrl.trim() && (
              <button type="button" className="sb-btn-solid sb-btn-small" onClick={handleImport} disabled={importing}>
                {importing ? "importing..." : "import recipe →"}
              </button>
            )}
          </div>
          {importNote && <p className="sb-import-note">{importNote}</p>}
          {importError && <p className="sb-login-error" style={{ marginTop: 8 }}>{importError}</p>}
        </label>

        <label className="sb-field sb-field-wide">
          <span>Recipe name</span>
          <input value={form.name} onChange={update("name")} placeholder="e.g. Weeknight Chicken Tacos" />
        </label>

        <div className="sb-form-grid">
          <label className="sb-field">
            <span>Cuisine</span>
            <select value={form.cuisine} onChange={update("cuisine")}>
              {CUISINES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="sb-field">
            <span>Main protein</span>
            <select value={form.protein} onChange={update("protein")}>
              {PROTEINS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="sb-field">
            <span>Time in minutes (optional)</span>
            <input type="number" value={form.timeMinutes} onChange={update("timeMinutes")} placeholder="30" />
          </label>
        </div>

        <div className="sb-recipe-tabs">
          <button
            type="button"
            className={"sb-recipe-tab" + (recipeTab === "ingredients" ? " sb-recipe-tab-active" : "")}
            onClick={() => setRecipeTab("ingredients")}
          >
            Ingredients
          </button>
          <button
            type="button"
            className={"sb-recipe-tab" + (recipeTab === "instructions" ? " sb-recipe-tab-active" : "")}
            onClick={() => setRecipeTab("instructions")}
          >
            Instructions
          </button>
        </div>

        {recipeTab === "ingredients" ? (
          <label className="sb-field sb-field-wide">
            <span className="sb-visually-hidden">Ingredients</span>
            <textarea
              rows={12}
              className="sb-textarea-large"
              value={form.ingredients}
              onChange={update("ingredients")}
              onKeyDown={(e) => handleBulletKeyDown(e, form.ingredients, (v) => setForm((f) => ({ ...f, ingredients: v })))}
              placeholder={"- 2 cups flour\n- 1 onion, diced\n- 2 cloves garlic"}
              autoFocus
            />
          </label>
        ) : (
          <label className="sb-field sb-field-wide">
            <span className="sb-visually-hidden">Instructions (optional)</span>
            <textarea
              rows={12}
              className="sb-textarea-large"
              value={form.instructions}
              onChange={update("instructions")}
              onKeyDown={(e) => handleBulletKeyDown(e, form.instructions, (v) => setForm((f) => ({ ...f, instructions: v })))}
              placeholder={"- Preheat oven to 400\u00b0F\n- Season and sear the chicken\n- Roast for 20 minutes"}
              autoFocus
            />
          </label>
        )}

        <label className="sb-field sb-field-wide">
          <span>Tags</span>
          <div className="sb-tag-input-row">
            <input
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addTag();
                }
              }}
              placeholder="e.g. kid-friendly, meal-prep"
            />
            <button type="button" className="sb-btn-solid sb-btn-small" onClick={addTag}>
              add tag
            </button>
          </div>
          {form.tags.length > 0 && (
            <div className="sb-chip-row" style={{ marginTop: 10 }}>
              {form.tags.map((t) => (
                <span key={t} className="sb-tag-editable">
                  {t}
                  <button
                    type="button"
                    className="sb-tag-remove"
                    onClick={() => removeTag(t)}
                    aria-label={`Remove tag ${t}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
        </label>

        <label className="sb-field sb-field-wide">
          <span>Family rating</span>
          <Stars value={form.rating} onChange={(n) => setForm({ ...form, rating: n === form.rating ? 0 : n })} size={22} />
        </label>

        <div className="sb-sheet-actions">
          {initial && (
            <button className="sb-btn-ghost sb-btn-danger" onClick={() => onDelete(initial.id)}>
              delete recipe
            </button>
          )}
          <div className="sb-sheet-actions-right">
            <button className="sb-btn-solid" disabled={!isValid} onClick={submit}>
              {initial ? "save changes" : "add to recipe box"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- "Help me pick" quiz ----------

function PickerQuiz({ recipes, onClose, onPick, targetDateLabel }) {
  const [cuisine, setCuisine] = useState(null);
  const [protein, setProtein] = useState(null);
  const [timeBucket, setTimeBucket] = useState(null);
  const [showResults, setShowResults] = useState(false);

  const matches = useMemo(() => {
    if (!showResults) return [];
    let pool = recipes.slice();
    const scored = pool.map((r) => {
      let score = 0;
      if (cuisine && r.cuisine === cuisine) score += 1;
      if (protein && r.protein === protein) score += 1;
      if (timeBucket && r.timeMinutes != null) {
        const bucket = TIME_BUCKETS.find((b) => r.timeMinutes <= b.max);
        if (bucket && bucket.label === timeBucket) score += 1;
      }
      return { r, score };
    });
    scored.sort((a, b) => b.score - a.score || b.r.rating - a.r.rating);
    return scored.slice(0, 5).map((s) => s.r);
  }, [showResults, cuisine, protein, timeBucket, recipes]);

  return (
    <div className="sb-modal-backdrop" onClick={onClose}>
      <div className="sb-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sb-eyebrow">{targetDateLabel ? `picking for ${targetDateLabel}` : "quick recipe finder"}</div>
        <h2 className="sb-sheet-title">Help me pick</h2>

        {!showResults ? (
          <>
            <div className="sb-quiz-block">
              <div className="sb-quiz-question">What kind of food?</div>
              <div className="sb-chip-row">
                {CUISINES.map((c) => (
                  <Chip key={c} label={c} active={cuisine === c} onClick={() => setCuisine(cuisine === c ? null : c)} />
                ))}
              </div>
            </div>
            <div className="sb-quiz-block">
              <div className="sb-quiz-question">Any protein in mind?</div>
              <div className="sb-chip-row">
                {PROTEINS.map((p) => (
                  <Chip key={p} label={p} active={protein === p} onClick={() => setProtein(protein === p ? null : p)} />
                ))}
              </div>
            </div>
            <div className="sb-quiz-block">
              <div className="sb-quiz-question">How much time do you have?</div>
              <div className="sb-chip-row">
                {TIME_BUCKETS.map((b) => (
                  <Chip
                    key={b.label}
                    label={b.label}
                    active={timeBucket === b.label}
                    onClick={() => setTimeBucket(timeBucket === b.label ? null : b.label)}
                  />
                ))}
              </div>
            </div>
            <div className="sb-sheet-actions">
              <div />
              <div className="sb-sheet-actions-right">
                <button className="sb-btn-ghost" onClick={onClose}>
                  cancel
                </button>
                <button className="sb-btn-solid" onClick={() => setShowResults(true)}>
                  show me options
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            {matches.length === 0 ? (
              <p className="sb-empty-note">Nothing in the recipe box fits yet — add a few more recipes and try again.</p>
            ) : (
              <div className="sb-quiz-results">
                {matches.map((r) => (
                  <div key={r.id} className="sb-quiz-result">
                    <div>
                      <div className="sb-card-tags">
                        <span className="sb-tag">{r.cuisine}</span>
                        <span className="sb-tag">{r.protein}</span>
                      </div>
                      <div className="sb-quiz-result-title">{r.name}</div>
                      <div className="sb-card-meta">{timeLabel(r.timeMinutes)}</div>
                    </div>
                    {onPick && (
                      <button className="sb-btn-solid sb-btn-small" onClick={() => onPick(r)}>
                        {targetDateLabel ? "pick this" : "view"}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="sb-sheet-actions">
              <button className="sb-btn-ghost" onClick={() => setShowResults(false)}>
                back
              </button>
              <button className="sb-btn-ghost" onClick={onClose}>
                close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Assign-a-day panel ----------

function AssignPanel({ date, recipes, onAssign, onClose, onOpenQuiz }) {
  const [search, setSearch] = useState("");
  const filtered = recipes.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
  const dateLabel = `${fmtDay(date)}, ${fmtDate(date)}`;

  return (
    <div className="sb-modal-backdrop" onClick={onClose}>
      <div className="sb-sheet" onClick={(e) => e.stopPropagation()}>
        <button type="button" className="sb-sheet-close" onClick={onClose} aria-label="Close">
          ×
        </button>
        <div className="sb-eyebrow">assigning dinner</div>
        <h2 className="sb-sheet-title">{dateLabel}</h2>

        <button className="sb-btn-solid sb-quiz-cta" onClick={onOpenQuiz}>
          not sure? help me pick →
        </button>

        <label className="sb-field sb-field-wide" style={{ marginTop: 18 }}>
          <span>Or choose from the recipe box</span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search recipes..." />
        </label>

        <div className="sb-assign-list">
          {filtered.length === 0 && <p className="sb-empty-note">No recipes match that search.</p>}
          {filtered.map((r) => (
            <div key={r.id} className="sb-quiz-result" onClick={() => onAssign(r)}>
              <div>
                <div className="sb-card-tags">
                  <span className="sb-tag">{r.cuisine}</span>
                  <span className="sb-tag">{r.protein}</span>
                </div>
                <div className="sb-quiz-result-title">{r.name}</div>
                <div className="sb-card-meta">{timeLabel(r.timeMinutes)}</div>
              </div>
              <button className="sb-btn-solid sb-btn-small">assign</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- login gate ----------

function LoginScreen({ onLogin, error, loading }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);

  const submit = (e) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    onLogin(email.trim(), password, rememberMe);
  };

  return (
    <div className="sb-app sb-login-app">
      <style>{BASE_STYLES}</style>
      <div className="sb-login-screen">
        <div className="sb-login-card">
          <div className="sb-eyebrow">family menu, locked</div>
          <h1 className="sb-title sb-login-title">Dinner Planner</h1>
          <p className="sb-login-sub">Sign in with the account made for you.</p>

          <form onSubmit={submit}>
            <label className="sb-field sb-field-wide">
              <span>Email</span>
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@family.com"
              />
            </label>
            <label className="sb-field sb-field-wide">
              <span>Password</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </label>

            <label className="sb-login-remember">
              <input type="checkbox" checked={rememberMe} onChange={(e) => setRememberMe(e.target.checked)} />
              <span>Keep me signed in on this device</span>
            </label>

            {error && <p className="sb-login-error">{error}</p>}

            <button className="sb-btn-solid sb-login-submit" type="submit" disabled={loading}>
              {loading ? "signing in..." : "sign in"}
            </button>
          </form>

          <p className="sb-login-note">
            Don't have an account yet? Ask whoever set up this app to create one for you.
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------- settings / user management ----------

function SettingsPanel({ onClose }) {
  const [users, setUsers] = useState(null); // null while loading
  const [loadErr, setLoadErr] = useState("");
  const [busyId, setBusyId] = useState(null); // user id currently being edited/saved
  const [actionErr, setActionErr] = useState("");

  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [creating, setCreating] = useState(false);

  const [editingEmailId, setEditingEmailId] = useState(null);
  const [emailDraft, setEmailDraft] = useState("");
  const [editingPasswordId, setEditingPasswordId] = useState(null);
  const [passwordDraft, setPasswordDraft] = useState("");

  const loadUsers = () => {
    setLoadErr("");
    apiListUsers()
      .then(setUsers)
      .catch((err) => setLoadErr(err.message));
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!newEmail.trim() || !newPassword) return;
    setCreating(true);
    setActionErr("");
    try {
      await apiCreateUser(newEmail.trim(), newPassword);
      setNewEmail("");
      setNewPassword("");
      loadUsers();
    } catch (err) {
      setActionErr(err.message);
    } finally {
      setCreating(false);
    }
  };

  const saveEmail = async (id) => {
    if (!emailDraft.trim()) return;
    setBusyId(id);
    setActionErr("");
    try {
      await apiUpdateUserEmail(id, emailDraft.trim());
      setEditingEmailId(null);
      loadUsers();
    } catch (err) {
      setActionErr(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const savePassword = async (id) => {
    if (!passwordDraft || passwordDraft.length < 6) {
      setActionErr("New password needs to be at least 6 characters.");
      return;
    }
    setBusyId(id);
    setActionErr("");
    try {
      await apiUpdateUserPassword(id, passwordDraft);
      setEditingPasswordId(null);
      setPasswordDraft("");
    } catch (err) {
      setActionErr(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const removeUser = async (id, email) => {
    if (!window.confirm(`Remove ${email}'s account? They won't be able to sign in anymore.`)) return;
    setBusyId(id);
    setActionErr("");
    try {
      await apiDeleteUser(id);
      loadUsers();
    } catch (err) {
      setActionErr(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="sb-modal-backdrop" onClick={onClose}>
      <div className="sb-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sb-eyebrow">family accounts</div>
        <h2 className="sb-sheet-title">Settings</h2>

        <form onSubmit={handleCreate} className="sb-settings-add">
          <div className="sb-quiz-question" style={{ marginBottom: 10 }}>
            Add a new family member
          </div>
          <div className="sb-form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <label className="sb-field">
              <span>Email</span>
              <input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@family.com" />
            </label>
            <label className="sb-field">
              <span>Password</span>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="at least 6 characters"
              />
            </label>
          </div>
          <button className="sb-btn-solid sb-btn-small" type="submit" disabled={creating}>
            {creating ? "adding..." : "+ add family member"}
          </button>
        </form>

        {actionErr && <p className="sb-login-error">{actionErr}</p>}

        <div className="sb-quiz-question" style={{ margin: "20px 0 10px" }}>
          Existing accounts
        </div>

        {loadErr && <p className="sb-login-error">{loadErr}</p>}
        {!users && !loadErr && <p className="sb-empty-note">Loading accounts...</p>}
        {users && users.length === 0 && <p className="sb-empty-note">No accounts yet.</p>}

        {users && users.length > 0 && (
          <div className="sb-settings-users">
            {users.map((u) => (
              <div key={u.id} className="sb-settings-user-row">
                {editingEmailId === u.id ? (
                  <div className="sb-settings-inline-edit">
                    <input
                      type="email"
                      value={emailDraft}
                      onChange={(e) => setEmailDraft(e.target.value)}
                      autoFocus
                    />
                    <button className="sb-btn-solid sb-btn-small" onClick={() => saveEmail(u.id)} disabled={busyId === u.id}>
                      save
                    </button>
                    <button className="sb-btn-ghost sb-btn-small" onClick={() => setEditingEmailId(null)}>
                      cancel
                    </button>
                  </div>
                ) : editingPasswordId === u.id ? (
                  <div className="sb-settings-inline-edit">
                    <input
                      type="password"
                      value={passwordDraft}
                      onChange={(e) => setPasswordDraft(e.target.value)}
                      placeholder="new password"
                      autoFocus
                    />
                    <button className="sb-btn-solid sb-btn-small" onClick={() => savePassword(u.id)} disabled={busyId === u.id}>
                      save
                    </button>
                    <button
                      className="sb-btn-ghost sb-btn-small"
                      onClick={() => {
                        setEditingPasswordId(null);
                        setPasswordDraft("");
                      }}
                    >
                      cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="sb-settings-user-email">{u.email}</div>
                    <div className="sb-settings-user-actions">
                      <button
                        className="sb-btn-ghost sb-btn-small"
                        onClick={() => {
                          setEditingEmailId(u.id);
                          setEmailDraft(u.email);
                        }}
                      >
                        edit email
                      </button>
                      <button
                        className="sb-btn-ghost sb-btn-small"
                        onClick={() => {
                          setEditingPasswordId(u.id);
                          setPasswordDraft("");
                        }}
                      >
                        reset password
                      </button>
                      <button
                        className="sb-btn-ghost sb-btn-small sb-btn-danger"
                        onClick={() => removeUser(u.id, u.email)}
                        disabled={busyId === u.id}
                      >
                        remove
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="sb-sheet-actions">
          <div />
          <button className="sb-btn-ghost" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}

// The Claude artifact preview exposes window.storage; a real deployed site
// never will. Used only to skip the login gate in-chat so the design can be
// reviewed without live Supabase access — has zero effect once deployed.
const isPreviewSandbox = typeof window !== "undefined" && !!window.storage;

// ---------- shopping list panel ----------

function ShoppingListPanel({ items, onAddItems, onToggle, onToggleHaveAtHome, onRemove, onClearChecked, onClearAll, days, calendar, recipeById, onClose }) {
  const [selectedDays, setSelectedDays] = useState(() => new Set());
  const [manualText, setManualText] = useState("");
  const [note, setNote] = useState("");
  const [addSectionOpen, setAddSectionOpen] = useState(true);

  const scheduledDays = days.flatMap((d) => {
    const dateKey = isoDate(d);
    const assignments = calendar[dateKey] || [];
    return assignments
      .map((a) => ({ d, key: a.id, recipe: recipeById(a.recipeId) }))
      .filter((row) => row.recipe);
  });

  const toggleDaySelection = (key) => {
    setSelectedDays((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAllScheduled = () => {
    setSelectedDays(new Set(scheduledDays.map((row) => row.key)));
  };

  const addFromSelectedDays = () => {
    setNote("");
    const chosenRecipes = [];
    const seenRecipeIds = new Set();
    scheduledDays.forEach((row) => {
      if (selectedDays.has(row.key) && !seenRecipeIds.has(row.recipe.id)) {
        seenRecipeIds.add(row.recipe.id);
        chosenRecipes.push(row.recipe);
      }
    });
    if (chosenRecipes.length === 0) {
      setNote("Pick at least one dinner first.");
      return;
    }

    // Existing items, keyed by normalized ingredient — used to merge new
    // recipe names into items that are already on the list.
    const existingByKey = new Map(items.map((i) => [normalizeIngredientKey(i.text), i]));
    const existingSourceSets = new Map(); // item id -> Set(sources), only for items gaining a new source
    const seenNew = new Map(); // normalized key -> { text, sources: Set<recipeName> }, for brand-new items

    chosenRecipes.forEach((r) => {
      parseIngredientLines(r.ingredients).forEach((line) => {
        const key = normalizeIngredientKey(line);
        const existing = existingByKey.get(key);
        if (existing) {
          const set = existingSourceSets.get(existing.id) || new Set(existing.sources || []);
          set.add(r.name);
          existingSourceSets.set(existing.id, set);
          return;
        }
        if (seenNew.has(key)) {
          seenNew.get(key).sources.add(r.name);
        } else {
          seenNew.set(key, { text: line, sources: new Set([r.name]) });
        }
      });
    });

    const newItems = [...seenNew.values()].map((v) => ({
      id: newShoppingItemId(),
      text: v.text,
      checked: false,
      haveAtHome: false,
      sources: [...v.sources],
    }));

    // Only send updates for items whose source list actually grew.
    const sourceUpdates = [...existingSourceSets.entries()]
      .map(([id, set]) => ({ id, sources: [...set] }))
      .filter(({ id, sources }) => {
        const original = items.find((i) => i.id === id);
        return !original || sources.length !== (original.sources || []).length;
      });

    if (newItems.length === 0 && sourceUpdates.length === 0) {
      setNote("Everything from those dinners is already on your list.");
      return;
    }

    onAddItems(newItems, sourceUpdates);
    setSelectedDays(new Set());
    const total = newItems.length + sourceUpdates.length;
    setNote(
      newItems.length > 0
        ? `Added ${newItems.length} item${newItems.length === 1 ? "" : "s"}` +
            (sourceUpdates.length > 0 ? `, updated ${sourceUpdates.length} existing.` : ".")
        : `Updated ${sourceUpdates.length} existing item${sourceUpdates.length === 1 ? "" : "s"}.`
    );
  };

  const addManualItem = (e) => {
    e.preventDefault();
    const text = manualText.trim();
    if (!text) return;
    onAddItems([{ id: newShoppingItemId(), text, checked: false, haveAtHome: false, sources: [] }]);
    setManualText("");
  };

  const unchecked = items.filter((i) => !i.checked);
  const checked = items.filter((i) => i.checked);

  const groupedItems = useMemo(() => {
    const bySection = {};
    GROCERY_SECTIONS.forEach((s) => (bySection[s] = []));
    items.forEach((i) => {
      bySection[guessGrocerySection(i.text)].push(i);
    });
    GROCERY_SECTIONS.forEach((s) => bySection[s].sort((a, b) => a.text.localeCompare(b.text)));
    return GROCERY_SECTIONS.map((s) => ({ section: s, items: bySection[s] })).filter((g) => g.items.length > 0);
  }, [items]);

  return (
    <div className="sb-modal-backdrop" onClick={onClose}>
      <div className="sb-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sb-eyebrow">family grocery list</div>
        <h2 className="sb-sheet-title">Shopping list</h2>

        <div className="sb-shop-section">
          <button
            type="button"
            className="sb-shop-section-toggle"
            onClick={() => setAddSectionOpen((open) => !open)}
            aria-expanded={addSectionOpen}
          >
            <span className="sb-quiz-question" style={{ marginBottom: 0 }}>
              Add ingredients from this week's dinners
            </span>
            <span className="sb-shop-section-chevron">{addSectionOpen ? "▾" : "▸"}</span>
          </button>
          {addSectionOpen && (
            <>
              {scheduledDays.length === 0 ? (
                <p className="sb-empty-note">No dinners scheduled yet — assign some on the calendar first.</p>
              ) : (
                <>
                  <div className="sb-shop-day-list">
                    {scheduledDays.map((row) => (
                      <label key={row.key} className="sb-shop-day-row">
                        <input
                          type="checkbox"
                          checked={selectedDays.has(row.key)}
                          onChange={() => toggleDaySelection(row.key)}
                        />
                        <span className="sb-shop-day-label">
                          {fmtDay(row.d)} {fmtDate(row.d)}
                        </span>
                        <span className="sb-shop-day-recipe">{row.recipe.name}</span>
                      </label>
                    ))}
                  </div>
                  <div className="sb-shop-day-actions">
                    <button type="button" className="sb-btn-ghost sb-btn-small" onClick={selectAllScheduled}>
                      select all
                    </button>
                    <button type="button" className="sb-btn-solid sb-btn-small" onClick={addFromSelectedDays}>
                      add ingredients to list
                    </button>
                  </div>
                  {note && <p className="sb-empty-note" style={{ marginTop: 6 }}>{note}</p>}
                </>
              )}
            </>
          )}
        </div>

        <div className="sb-quiz-question" style={{ margin: "20px 0 10px" }}>
          The list ({unchecked.length} to get{checked.length > 0 ? `, ${checked.length} done` : ""})
        </div>

        <form onSubmit={addManualItem} className="sb-shop-add-row">
          <input
            value={manualText}
            onChange={(e) => setManualText(e.target.value)}
            placeholder="Add an item, e.g. paper towels"
          />
          <button className="sb-btn-solid sb-btn-small" type="submit">
            add
          </button>
        </form>

        {items.length === 0 ? (
          <p className="sb-empty-note">Your list is empty — add dinners above or type an item in.</p>
        ) : (
          <>
            <div className="sb-shop-col-headers">
              <span className="sb-shop-col-label">home</span>
              <span className="sb-shop-col-label">store</span>
              <span />
              <span />
            </div>
            <div className="sb-shop-groups-scroll">
              {groupedItems.map(({ section, items: sectionItems }) => (
                <div key={section} className="sb-shop-section-group">
                  <div className="sb-shop-section-title">{section}</div>
                  <div className="sb-shop-items">
                    {sectionItems.map((i) => (
                      <div key={i.id} className={"sb-shop-item-row" + (i.checked ? " sb-shop-item-checked" : "")}>
                        <input
                          type="checkbox"
                          className="sb-check sb-check-home"
                          checked={!!i.haveAtHome}
                          onChange={() => onToggleHaveAtHome(i.id, !i.haveAtHome)}
                          aria-label="Already have at home"
                        />
                        <input
                          type="checkbox"
                          className="sb-check sb-check-store"
                          checked={!!i.checked}
                          onChange={() => onToggle(i.id, !i.checked)}
                          aria-label="Store"
                        />
                        <span className="sb-shop-item-main">
                          <span className={"sb-shop-item-text" + (i.haveAtHome ? " sb-shop-item-have" : "")}>{i.text}</span>
                          {i.sources && i.sources.length > 0 && (
                            <span className="sb-shop-item-sources">for {i.sources.join(", ")}</span>
                          )}
                        </span>
                        <button type="button" className="sb-shop-item-remove" onClick={() => onRemove(i.id)} aria-label="Remove item">
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="sb-sheet-actions">
          <div className="sb-shop-clear-actions">
            {checked.length > 0 && (
              <button className="sb-btn-ghost sb-btn-danger" onClick={onClearChecked}>
                clear checked items
              </button>
            )}
            {items.length > 0 && (
              <button
                className="sb-btn-ghost sb-btn-danger"
                onClick={() => {
                  if (window.confirm("Start a new list? This removes everything currently on it.")) {
                    onClearAll();
                  }
                }}
              >
                start new list
              </button>
            )}
          </div>
          <button className="sb-btn-ghost" onClick={onClose}>
            close
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- main app ----------

export default function SupperBoard() {
  const [session, setSession] = useState(() =>
    isPreviewSandbox ? { access_token: null, user: { email: "preview@local" } } : null
  );
  const [restoringSession, setRestoringSession] = useState(!isPreviewSandbox);
  const [authError, setAuthError] = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const [recipes, setRecipes] = useState([]);
  const [calendar, setCalendar] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");

  const [boxSearch, setBoxSearch] = useState("");
  const [boxCuisine, setBoxCuisine] = useState(null);
  const [boxProtein, setBoxProtein] = useState(null);
  const [boxTag, setBoxTag] = useState(null);
  const [boxSort, setBoxSort] = useState("name"); // "name" | "rating" | "time"

  const [editingRecipe, setEditingRecipe] = useState(null); // "new" | recipe | null
  const [assignDate, setAssignDate] = useState(null); // Date | null
  const [quizOpen, setQuizOpen] = useState(false); // bool, standalone quiz from header
  const [quizForDate, setQuizForDate] = useState(null); // Date | null, quiz launched from a slot
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [shoppingItems, setShoppingItems] = useState([]);
  const [dayCarouselIndex, setDayCarouselIndex] = useState({}); // { [dateKey]: number }
  const setDayIndex = (key, idx) => setDayCarouselIndex((prev) => ({ ...prev, [key]: idx }));

  // ---- try to silently restore a "remembered" session on first load ----
  useEffect(() => {
    if (isPreviewSandbox) return;
    let cancelled = false;
    (async () => {
      const remembered = loadRememberedSession();
      if (!remembered || !remembered.refresh_token) {
        setRestoringSession(false);
        return;
      }
      try {
        const data = await apiRefreshSession(remembered.refresh_token);
        if (cancelled) return;
        currentAccessToken = data.access_token;
        setSession(data);
        saveRememberedSession(data.refresh_token); // Supabase rotates refresh tokens
      } catch {
        clearRememberedSession();
      } finally {
        if (!cancelled) setRestoringSession(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async (email, password, rememberMe) => {
    setAuthLoading(true);
    setAuthError("");
    try {
      const data = await apiLogin(email, password);
      currentAccessToken = data.access_token;
      setSession(data);
      if (rememberMe) saveRememberedSession(data.refresh_token);
      else clearRememberedSession();
    } catch (err) {
      setAuthError(err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = async () => {
    if (session) await apiLogout(session.access_token);
    currentAccessToken = null;
    clearRememberedSession();
    setSession(null);
    // Reset app state so the next login starts from a clean load.
    setRecipes([]);
    setCalendar({});
    setLoading(true);
  };

  // ---- drag & drop (mouse drags immediately, touch arms after a short hold) ----
  const [dragActiveKey, setDragActiveKey] = useState(null); // which card instance is being dragged
  const [dragRecipeName, setDragRecipeName] = useState("");
  const [hoverDate, setHoverDate] = useState(null); // iso date string of the day currently under the pointer

  const dragRef = useRef(null); // mutable pointer-tracking state for the active drag gesture
  const hoverDateRef = useRef(null);
  const calendarRef = useRef({});
  const ghostElRef = useRef(null);
  useEffect(() => {
    calendarRef.current = calendar;
  }, [calendar]);

  const TOUCH_HOLD_MS = 220;
  const MOVE_THRESHOLD = 7;

  const positionGhost = (x, y) => {
    if (ghostElRef.current) {
      ghostElRef.current.style.left = x + "px";
      ghostElRef.current.style.top = y + "px";
    }
  };

  const updateHoverTarget = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const dayEl = el && el.closest("[data-drop-date]");
    const nextDate = dayEl ? dayEl.getAttribute("data-drop-date") : null;
    if (nextDate !== hoverDateRef.current) {
      hoverDateRef.current = nextDate;
      setHoverDate(nextDate);
    }
  };

  // Backup for iOS Safari, where preventDefault() inside a pointermove
  // handler doesn't always reliably suppress the native scroll gesture the
  // way it does in other browsers. This blocks scrolling directly via the
  // underlying touch event once a drag is in progress.
  const blockTouchScroll = (e) => {
    if (dragRef.current) e.preventDefault();
  };

  const cleanupDragListeners = () => {
    document.removeEventListener("pointermove", onDocPointerMove);
    document.removeEventListener("pointerup", onDocPointerUp);
    document.removeEventListener("pointercancel", onDocPointerUp);
    document.removeEventListener("touchmove", blockTouchScroll);
  };

  const endDragVisuals = () => {
    setDragActiveKey(null);
    setDragRecipeName("");
    setHoverDate(null);
    hoverDateRef.current = null;
    if (ghostElRef.current) ghostElRef.current.style.display = "none";
    document.body.style.webkitUserSelect = "";
    document.body.style.userSelect = "";
  };

  const suppressNextClick = () => {
    const swallow = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    document.addEventListener("click", swallow, { capture: true, once: true });
  };

  // Moves/swaps/assigns a recipe onto a day, persisting to Supabase and
  // updating local state. `sourceDate` is null when dragging from the recipe box.
  const performDrop = async (recipe, sourceDate, assignmentId, dropDateStr) => {
    if (!dropDateStr) return;

    if (!sourceDate) {
      // Dragged straight from the recipe box — add it alongside whatever's already there.
      if (isPreviewSandbox) {
        const entry = { id: newShoppingItemId(), recipeId: recipe.id };
        setCalendar((prev) => ({ ...prev, [dropDateStr]: [...(prev[dropDateStr] || []), entry] }));
        return;
      }
      try {
        const entry = await apiAddAssignment(dropDateStr, recipe.id);
        const nextList = [...(calendar[dropDateStr] || []), entry];
        setCalendar((prev) => ({ ...prev, [dropDateStr]: nextList }));
        setActionError("");
        syncDayToGoogle(dropDateStr, namesForAssignments(nextList));
      } catch (err) {
        console.error(err);
        setActionError(err.message);
      }
      return;
    }

    const sourceStr = isoDate(sourceDate);
    if (sourceStr === dropDateStr) return; // dropped back on itself

    // Move just this one assignment from the source day to the destination day.
    const sourceListBefore = calendarRef.current[sourceStr] || [];
    const moved = sourceListBefore.find((a) => a.id === assignmentId);
    const sourceListAfter = sourceListBefore.filter((a) => a.id !== assignmentId);
    const destListAfter = moved ? [...(calendarRef.current[dropDateStr] || []), moved] : calendarRef.current[dropDateStr] || [];

    setCalendar((prev) => {
      const next = { ...prev };
      if (sourceListAfter.length > 0) next[sourceStr] = sourceListAfter;
      else delete next[sourceStr];
      if (moved) next[dropDateStr] = destListAfter;
      return next;
    });

    if (isPreviewSandbox) return;

    try {
      await apiMoveAssignment(assignmentId, dropDateStr);
      setActionError("");
      syncDayToGoogle(sourceStr, namesForAssignments(sourceListAfter));
      syncDayToGoogle(dropDateStr, namesForAssignments(destListAfter));
    } catch (err) {
      console.error(err);
      setActionError(err.message);
      // Fall back to the server's version of the calendar so we don't drift.
      try {
        const fresh = await apiListCalendar();
        setCalendar(fresh);
      } catch {
        /* ignore secondary failure */
      }
    }
  };

  function onDocPointerMove(e) {
    const ds = dragRef.current;
    if (!ds || e.pointerId !== ds.pointerId) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    const dist = Math.hypot(dx, dy);

    if (!ds.armed) {
      if (ds.pointerType === "mouse" && dist > MOVE_THRESHOLD) {
        ds.armed = true;
        setDragActiveKey(ds.key);
        setDragRecipeName(ds.recipe.name);
        if (ghostElRef.current) ghostElRef.current.style.display = "block";
        document.body.style.webkitUserSelect = "none";
        document.body.style.userSelect = "none";
      }
      return; // touch just waits for the hold timer
    }

    ds.moved = true;
    e.preventDefault();
    positionGhost(e.clientX, e.clientY);
    updateHoverTarget(e.clientX, e.clientY);
  }

  function onDocPointerUp(e) {
    const ds = dragRef.current;
    if (!ds || e.pointerId !== ds.pointerId) return;
    if (ds.holdTimer) clearTimeout(ds.holdTimer);
    cleanupDragListeners();

    if (ds.armed && ds.moved) {
      suppressNextClick();
      const dropDateStr = hoverDateRef.current;
      performDrop(ds.recipe, ds.sourceDate, ds.assignmentId, dropDateStr);
    }

    dragRef.current = null;
    endDragVisuals();
  }

  const startDrag = (e, recipe, sourceDate, assignmentId) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const isTouch = e.pointerType !== "mouse";
    const key = sourceDate ? "day-" + isoDate(sourceDate) + "-" + assignmentId : "box-" + recipe.id;

    const dragSession = {
      recipe,
      sourceDate,
      assignmentId,
      key,
      pointerId: e.pointerId,
      pointerType: e.pointerType,
      startX: e.clientX,
      startY: e.clientY,
      armed: false,
      moved: false,
      holdTimer: null,
    };
    dragRef.current = dragSession;

    document.addEventListener("pointermove", onDocPointerMove);
    document.addEventListener("pointerup", onDocPointerUp);
    document.addEventListener("pointercancel", onDocPointerUp);
    if (isTouch) {
      document.addEventListener("touchmove", blockTouchScroll, { passive: false });
    }

    if (isTouch) {
      dragSession.holdTimer = window.setTimeout(() => {
        if (dragRef.current !== dragSession) return; // gesture already ended/replaced
        dragSession.armed = true;
        setDragActiveKey(key);
        setDragRecipeName(recipe.name);
        if (ghostElRef.current) {
          ghostElRef.current.style.display = "block";
          positionGhost(dragSession.startX, dragSession.startY);
        }
        document.body.style.webkitUserSelect = "none";
        document.body.style.userSelect = "none";
      }, TOUCH_HOLD_MS);
    }
  };

  const days = useMemo(() => nextTwoWeeks(), []);

  // ---- load from Supabase once signed in ----
  useEffect(() => {
    if (!session) return;
    (async () => {
      try {
        let recipesValue = await apiListRecipes();
        if (recipesValue.length === 0) {
          recipesValue = await apiSeedRecipes(SEED_RECIPES);
        }
        setRecipes(recipesValue);

        const calendarValue = await apiListCalendar();
        setCalendar(calendarValue);

        const shoppingValue = await apiListShoppingItems();
        setShoppingItems(shoppingValue);
      } catch (err) {
        console.error("Dinner Planner load error:", err);
        if (isPreviewSandbox) {
          // Chat preview can't reach Supabase at all — show local demo data
          // instead of an error so the design can still be reviewed.
          setRecipes(SEED_RECIPES);
          setCalendar({});
          setShoppingItems([]);
        } else {
          setLoadError(true);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [session]);

  const saveRecipe = async (recipe) => {
    if (isPreviewSandbox) {
      const exists = recipes.some((r) => r.id === recipe.id);
      setRecipes((prev) => (exists ? prev.map((r) => (r.id === recipe.id ? recipe : r)) : [...prev, recipe]));
      setEditingRecipe(null);
      return;
    }
    try {
      const existing = recipes.find((r) => r.id === recipe.id);
      const exists = !!existing;
      const nameChanged = exists && existing.name !== recipe.name;
      const saved = exists ? await apiUpdateRecipe(recipe) : await apiInsertRecipe(recipe);
      setRecipes((prev) => (exists ? prev.map((r) => (r.id === saved.id ? saved : r)) : [...prev, saved]));
      setEditingRecipe(null);
      setActionError("");
      if (nameChanged) {
        const updatedRecipes = recipes.map((r) => (r.id === saved.id ? saved : r));
        Object.keys(calendar).forEach((date) => {
          if (calendar[date].some((a) => a.recipeId === saved.id)) {
            syncDayToGoogle(date, namesForAssignments(calendar[date], updatedRecipes));
          }
        });
      }
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const deleteRecipe = async (id) => {
    const clearFromCalendar = (prev) => {
      const next = {};
      Object.keys(prev).forEach((date) => {
        const remaining = prev[date].filter((a) => a.recipeId !== id);
        if (remaining.length > 0) next[date] = remaining;
      });
      return next;
    };

    if (isPreviewSandbox) {
      setRecipes((prev) => prev.filter((r) => r.id !== id));
      setCalendar(clearFromCalendar);
      setEditingRecipe(null);
      return;
    }
    try {
      const recipeBeingDeleted = recipes.find((r) => r.id === id);
      const affectedDates = Object.keys(calendar).filter((date) => calendar[date].some((a) => a.recipeId === id));
      await apiDeleteRecipe(id);
      await apiDeleteAssignmentsByRecipe(id);
      if (recipeBeingDeleted?.photoUrl) {
        apiDeleteRecipePhoto(recipeBeingDeleted.photoUrl); // best-effort, not awaited-critical
      }
      setRecipes((prev) => prev.filter((r) => r.id !== id));
      setCalendar(clearFromCalendar);
      setEditingRecipe(null);
      setActionError("");
      affectedDates.forEach((date) => {
        const remainingNames = namesForAssignments(calendar[date].filter((a) => a.recipeId !== id));
        syncDayToGoogle(date, remainingNames);
      });
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const rateRecipe = async (id, rating) => {
    if (isPreviewSandbox) {
      setRecipes((prev) => prev.map((r) => (r.id === id ? { ...r, rating } : r)));
      return;
    }
    try {
      const saved = await apiUpdateRating(id, rating);
      setRecipes((prev) => prev.map((r) => (r.id === id ? saved : r)));
      setActionError("");
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  // Adds a recipe to a day alongside whatever's already scheduled there —
  // days can now hold more than one dinner.
  const assignToDate = async (date, recipe) => {
    const key = isoDate(date);
    if (isPreviewSandbox) {
      const entry = { id: newShoppingItemId(), recipeId: recipe.id };
      setCalendar((prev) => ({ ...prev, [key]: [...(prev[key] || []), entry] }));
      setAssignDate(null);
      setQuizForDate(null);
      return;
    }
    try {
      const entry = await apiAddAssignment(key, recipe.id);
      const nextList = [...(calendar[key] || []), entry];
      setCalendar((prev) => ({ ...prev, [key]: nextList }));
      setAssignDate(null);
      setQuizForDate(null);
      setActionError("");
      syncDayToGoogle(key, namesForAssignments(nextList));
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  // Removes one specific recipe from one specific day (not the whole day).
  const removeAssignment = async (date, assignmentId) => {
    const key = isoDate(date);
    const nextList = (calendar[key] || []).filter((a) => a.id !== assignmentId);
    const applyLocal = (prev) => {
      const next = { ...prev };
      if (nextList.length > 0) next[key] = nextList;
      else delete next[key];
      return next;
    };
    if (isPreviewSandbox) {
      setCalendar(applyLocal);
      return;
    }
    try {
      await apiRemoveAssignment(assignmentId);
      setCalendar(applyLocal);
      setActionError("");
      syncDayToGoogle(key, namesForAssignments(nextList));
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const recipeById = (id) => recipes.find((r) => r.id === id);

  // Fire-and-forget sync to Google Calendar — never blocks the UI or the
  // in-app action if it fails; errors just get logged.
  const syncDayToGoogle = (dateKey, names) => {
    if (isPreviewSandbox) return; // no /api routes reachable from the chat preview
    fetch("/api/sync-calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${currentAccessToken || ""}` },
      body: JSON.stringify({ date: dateKey, recipeNames: names }),
    }).catch((err) => console.error("Google Calendar sync failed:", err));
  };

  const namesForAssignments = (assignments, recipesList) =>
    assignments
      .map((a) => (recipesList || recipes).find((r) => r.id === a.recipeId))
      .filter(Boolean)
      .map((r) => r.name);

  const addShoppingItems = async (newItems, sourceUpdates = []) => {
    if (newItems.length > 0) {
      setShoppingItems((prev) => [...prev, ...newItems]);
    }
    if (sourceUpdates.length > 0) {
      const updateMap = new Map(sourceUpdates.map((u) => [u.id, u.sources]));
      setShoppingItems((prev) => prev.map((i) => (updateMap.has(i.id) ? { ...i, sources: updateMap.get(i.id) } : i)));
    }
    if (isPreviewSandbox) return;
    try {
      if (newItems.length > 0) await apiInsertShoppingItems(newItems);
      if (sourceUpdates.length > 0) {
        await Promise.all(sourceUpdates.map((u) => apiUpdateShoppingItemSources(u.id, u.sources)));
      }
      setActionError("");
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const toggleShoppingItem = async (id, checkedValue) => {
    setShoppingItems((prev) => prev.map((i) => (i.id === id ? { ...i, checked: checkedValue } : i)));
    if (isPreviewSandbox) return;
    try {
      await apiUpdateShoppingItem(id, checkedValue);
      setActionError("");
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const toggleHaveAtHome = async (id, haveAtHome) => {
    setShoppingItems((prev) => prev.map((i) => (i.id === id ? { ...i, haveAtHome } : i)));
    if (isPreviewSandbox) return;
    try {
      await apiUpdateShoppingItemHaveAtHome(id, haveAtHome);
      setActionError("");
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const removeShoppingItem = async (id) => {
    setShoppingItems((prev) => prev.filter((i) => i.id !== id));
    if (isPreviewSandbox) return;
    try {
      await apiDeleteShoppingItem(id);
      setActionError("");
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const clearCheckedShoppingItems = async () => {
    const checkedIds = shoppingItems.filter((i) => i.checked).map((i) => i.id);
    setShoppingItems((prev) => prev.filter((i) => !i.checked));
    if (isPreviewSandbox || checkedIds.length === 0) return;
    try {
      await apiDeleteShoppingItems(checkedIds);
      setActionError("");
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const clearAllShoppingItems = async () => {
    const allIds = shoppingItems.map((i) => i.id);
    setShoppingItems([]);
    if (isPreviewSandbox || allIds.length === 0) return;
    try {
      await apiDeleteShoppingItems(allIds);
      setActionError("");
    } catch (err) {
      console.error(err);
      setActionError(err.message);
    }
  };

  const allTags = useMemo(() => {
    const set = new Set();
    recipes.forEach((r) => (r.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort();
  }, [recipes]);

  const visibleRecipes = useMemo(() => {
    const q = boxSearch.trim().toLowerCase();
    let list = recipes.filter((r) => {
      if (!q) return true;
      const tagMatch = (r.tags || []).some((t) => t.includes(q));
      return r.name.toLowerCase().includes(q) || tagMatch;
    });
    if (boxCuisine) list = list.filter((r) => r.cuisine === boxCuisine);
    if (boxProtein) list = list.filter((r) => r.protein === boxProtein);
    if (boxTag) list = list.filter((r) => (r.tags || []).includes(boxTag));
    list = list.slice();
    if (boxSort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    if (boxSort === "rating") list.sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
    if (boxSort === "time") {
      const t = (r) => (r.timeMinutes == null ? Infinity : r.timeMinutes);
      list.sort((a, b) => t(a) - t(b) || a.name.localeCompare(b.name));
    }
    return list;
  }, [recipes, boxSearch, boxCuisine, boxProtein, boxTag, boxSort]);

  const boxFiltersActive = boxSearch.trim() || boxCuisine || boxProtein || boxTag || boxSort !== "name";

  if (restoringSession) {
    return (
      <div className="sb-app">
        <style>{BASE_STYLES}</style>
        <p className="sb-loading">Checking your sign-in...</p>
      </div>
    );
  }

  if (!session) {
    return <LoginScreen onLogin={handleLogin} error={authError} loading={authLoading} />;
  }

  if (loading) {
    return (
      <div className="sb-app">
        <style>{BASE_STYLES}</style>
        <p className="sb-loading">Loading the family menu...</p>
      </div>
    );
  }

  return (
    <div className="sb-app">
      <style>{BASE_STYLES}</style>

      <div className="sb-header">
        <div>
          <div className="sb-eyebrow sb-eyebrow-light">
            the family menu, two weeks out{isPreviewSandbox && <span className="sb-preview-badge">preview mode</span>}
          </div>
          <h1 className="sb-title">Dinner Planner</h1>
        </div>
        <div className="sb-header-actions">
          <button className="sb-btn-ghost-light" onClick={() => setQuizOpen(true)}>
            help me pick
          </button>
          <button className="sb-btn-solid" onClick={() => setEditingRecipe("new")}>
            + add recipe
          </button>
          <button className="sb-btn-icon" onClick={() => setShoppingOpen(true)} aria-label="Shopping list" title="Shopping list">
            🛒
            {shoppingItems.some((i) => !i.checked) && (
              <span className="sb-cart-badge">{shoppingItems.filter((i) => !i.checked).length}</span>
            )}
          </button>
          {!isPreviewSandbox && session?.user?.email === ADMIN_EMAIL && (
            <button className="sb-btn-icon" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
              ⚙
            </button>
          )}
          {!isPreviewSandbox && (
            <button className="sb-btn-ghost-light" onClick={handleLogout}>
              log out
            </button>
          )}
        </div>
      </div>

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      {shoppingOpen && (
        <ShoppingListPanel
          items={shoppingItems}
          onAddItems={addShoppingItems}
          onToggle={toggleShoppingItem}
          onToggleHaveAtHome={toggleHaveAtHome}
          onRemove={removeShoppingItem}
          onClearChecked={clearCheckedShoppingItems}
          onClearAll={clearAllShoppingItems}
          days={days}
          calendar={calendar}
          recipeById={recipeById}
          onClose={() => setShoppingOpen(false)}
        />
      )}

      {loadError && (
        <p className="sb-empty-note" style={{ padding: "12px 28px 0", color: "#C1442E" }}>
          Couldn't reach the database — check that the Supabase project URL, key, and tables are set up correctly.
        </p>
      )}

      {actionError && (
        <p className="sb-empty-note" style={{ padding: "12px 28px 0", color: "#C1442E" }}>
          {actionError}
        </p>
      )}

      <div className="sb-cork">
        <div className="sb-calendar-grid">
          {days.map((d) => {
            const key = isoDate(d);
            const assignments = calendar[key] || [];
            const rawIdx = dayCarouselIndex[key] || 0;
            const idx = assignments.length ? Math.min(rawIdx, assignments.length - 1) : 0;
            const current = assignments[idx];
            const recipe = current ? recipeById(current.recipeId) : null;
            const todayKey = isoDate(new Date());
            const isToday = key === todayKey;
            const isPast = key < todayKey;
            const draggingFromThisDay = dragActiveKey && dragActiveKey.startsWith("day-" + key + "-");
            const isHovered = hoverDate === key && !draggingFromThisDay;
            return (
              <div
                key={key}
                className={"sb-day-col" + (isHovered ? " sb-day-col-hover" : "") + (isPast ? " sb-day-col-past" : "")}
                data-drop-date={isPast ? undefined : key}
              >
                <div className={"sb-day-label" + (isToday ? " sb-day-label-today" : "")}>
                  <span className="sb-day-name">{fmtDay(d)}</span>
                  <span className="sb-day-date">{fmtDate(d)}</span>
                </div>
                {recipe ? (
                  <div className="sb-day-card-stack">
                    <RecipeCard
                      recipe={recipe}
                      pinned
                      onOpen={() => setEditingRecipe(recipe)}
                      onRemove={() => removeAssignment(d, current.id)}
                      onDragStart={(e, r) => startDrag(e, r, d, current.id)}
                      dragging={dragActiveKey === "day-" + key + "-" + current.id}
                    />
                    {assignments.length > 1 && (
                      <div className="sb-day-carousel">
                        <button
                          type="button"
                          className="sb-day-carousel-arrow"
                          onClick={() => setDayIndex(key, (idx - 1 + assignments.length) % assignments.length)}
                          aria-label="Previous recipe"
                        >
                          ‹
                        </button>
                        <div className="sb-day-carousel-dots">
                          {assignments.map((a, i) => (
                            <button
                              key={a.id}
                              type="button"
                              className={"sb-day-carousel-dot" + (i === idx ? " sb-day-carousel-dot-active" : "")}
                              onClick={() => setDayIndex(key, i)}
                              aria-label={`Show recipe ${i + 1} of ${assignments.length}`}
                            />
                          ))}
                        </div>
                        <button
                          type="button"
                          className="sb-day-carousel-arrow"
                          onClick={() => setDayIndex(key, (idx + 1) % assignments.length)}
                          aria-label="Next recipe"
                        >
                          ›
                        </button>
                      </div>
                    )}
                    {!isPast && (
                      <button type="button" className="sb-day-add-more" onClick={() => setAssignDate(d)}>
                        + add another
                      </button>
                    )}
                  </div>
                ) : isPast ? (
                  <div className="sb-slot-past">no dinner</div>
                ) : (
                  <EmptySlot onClick={() => setAssignDate(d)} hovered={isHovered} />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="sb-drag-ghost" ref={ghostElRef} style={{ display: "none" }}>
        <div className="sb-drag-ghost-label">moving</div>
        <div className="sb-drag-ghost-title">{dragRecipeName}</div>
      </div>

      <div className="sb-box-section">
        <div className="sb-eyebrow">{recipes.length} recipes saved</div>
        <h2 className="sb-section-title">The recipe box</h2>

        {recipes.length === 0 ? (
          <p className="sb-empty-note">The box is empty — add your first family recipe to get started.</p>
        ) : (
          <>
            <div className="sb-box-toolbar">
              <input
                className="sb-search-input"
                value={boxSearch}
                onChange={(e) => setBoxSearch(e.target.value)}
                placeholder="Search recipes..."
              />
              <select className="sb-sort-select" value={boxSort} onChange={(e) => setBoxSort(e.target.value)}>
                <option value="name">Sort: name (A–Z)</option>
                <option value="rating">Sort: rating (high to low)</option>
                <option value="time">Sort: time (quickest first)</option>
              </select>
              {boxFiltersActive && (
                <button
                  className="sb-btn-ghost sb-btn-small"
                  onClick={() => {
                    setBoxSearch("");
                    setBoxCuisine(null);
                    setBoxProtein(null);
                    setBoxTag(null);
                    setBoxSort("name");
                  }}
                >
                  clear filters
                </button>
              )}
            </div>

            <div className="sb-filter-rows">
              <div className="sb-chip-row">
                {CUISINES.map((c) => (
                  <Chip key={c} label={c} active={boxCuisine === c} onClick={() => setBoxCuisine(boxCuisine === c ? null : c)} />
                ))}
              </div>
              <div className="sb-chip-row">
                {PROTEINS.map((p) => (
                  <Chip key={p} label={p} active={boxProtein === p} onClick={() => setBoxProtein(boxProtein === p ? null : p)} />
                ))}
              </div>
              {allTags.length > 0 && (
                <div className="sb-chip-row">
                  {allTags.map((t) => (
                    <Chip key={t} label={t} active={boxTag === t} onClick={() => setBoxTag(boxTag === t ? null : t)} />
                  ))}
                </div>
              )}
            </div>

            {visibleRecipes.length === 0 ? (
              <p className="sb-empty-note">No recipes match those filters.</p>
            ) : (
              <div className="sb-box-grid">
                {visibleRecipes.map((r) => (
                  <RecipeCard
                    key={r.id}
                    recipe={r}
                    onOpen={() => setEditingRecipe(r)}
                    onDragStart={(e, recipe) => startDrag(e, recipe, null)}
                    dragging={dragActiveKey === "box-" + r.id}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {editingRecipe && (
        <RecipeForm
          initial={editingRecipe === "new" ? null : editingRecipe}
          onSave={saveRecipe}
          onCancel={() => setEditingRecipe(null)}
          onDelete={deleteRecipe}
        />
      )}

      {assignDate && (
        <AssignPanel
          date={assignDate}
          recipes={recipes}
          onAssign={(r) => assignToDate(assignDate, r)}
          onClose={() => setAssignDate(null)}
          onOpenQuiz={() => {
            setQuizForDate(assignDate);
            setAssignDate(null);
          }}
        />
      )}

      {quizOpen && (
        <PickerQuiz
          recipes={recipes}
          onClose={() => setQuizOpen(false)}
          onPick={(r) => {
            setEditingRecipe(r);
            setQuizOpen(false);
          }}
        />
      )}

      {quizForDate && (
        <PickerQuiz
          recipes={recipes}
          targetDateLabel={`${fmtDay(quizForDate)}, ${fmtDate(quizForDate)}`}
          onClose={() => setQuizForDate(null)}
          onPick={(r) => assignToDate(quizForDate, r)}
        />
      )}
    </div>
  );
}

// ---------- styles ----------

const BASE_STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=Zilla+Slab:wght@500;600;700&family=Inter:wght@400;500;600;700&family=Caveat:wght@500;600&display=swap');

  .sb-app {
    --chalk: #2B3A32;
    --card: #F5EAC8;
    --card-edge: #E4D6AC;
    --herb: #4F7A5B;
    --marigold: #E3A430;
    --tomato: #C1442E;
    --cork: #B98A55;
    --ink: #2A2521;
    font-family: 'Inter', sans-serif;
    color: var(--ink);
    background: #EFE7CE;
    border-radius: 14px;
    overflow: hidden;
    min-height: 600px;
  }
  .sb-loading {
    padding: 60px 28px;
    font-family: 'Caveat', cursive;
    font-size: 22px;
    color: var(--chalk);
  }

  .sb-login-screen {
    background: var(--chalk);
    min-height: 600px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 20px;
  }
  .sb-login-card {
    background: #FBF6E4;
    border-radius: 10px;
    padding: 32px 30px;
    width: 100%;
    max-width: 380px;
  }
  .sb-login-title { color: var(--chalk); font-size: 28px; margin-bottom: 6px; }
  .sb-login-sub { font-size: 13px; color: #6b6250; margin: 0 0 22px; }
  .sb-login-remember {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: #6b6250;
    margin: -6px 0 16px;
    cursor: pointer;
  }
  .sb-login-error {
    background: #FBEAE6;
    border: 1px solid #E2B3A7;
    color: var(--tomato);
    font-size: 13px;
    padding: 9px 12px;
    border-radius: 5px;
    margin: -4px 0 16px;
  }
  .sb-login-submit { width: 100%; margin-top: 4px; }
  .sb-login-note { font-size: 12px; color: #8a8168; margin: 18px 0 0; text-align: center; }

  .sb-header {
    background: var(--chalk);
    color: #F5EAC8;
    padding: 28px 28px 24px;
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    flex-wrap: wrap;
    gap: 14px;
  }
  .sb-eyebrow {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--herb);
    margin-bottom: 6px;
  }
  .sb-eyebrow-light { color: #B7CBBB; }
  .sb-preview-badge {
    display: inline-block;
    margin-left: 8px;
    padding: 2px 8px;
    background: var(--marigold);
    color: #3A2504;
    border-radius: 10px;
    font-size: 9px;
    letter-spacing: 0.5px;
  }
  .sb-title {
    font-family: 'Zilla Slab', serif;
    font-weight: 700;
    font-size: 34px;
    margin: 0;
    color: #F8F2DD;
  }
  .sb-header-actions { display: flex; gap: 10px; align-items: center; }
  .sb-btn-icon {
    background: rgba(255,255,255,0.08);
    border: 1px solid rgba(255,255,255,0.25);
    color: #F5EAC8;
    width: 40px;
    height: 40px;
    border-radius: 5px;
    font-size: 17px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .sb-btn-icon:hover { background: rgba(255,255,255,0.16); }
  .sb-btn-icon { position: relative; }
  .sb-cart-badge {
    position: absolute;
    top: -6px;
    right: -6px;
    background: var(--tomato);
    color: #fff;
    font-family: 'Inter', sans-serif;
    font-size: 10px;
    font-weight: 700;
    min-width: 17px;
    height: 17px;
    border-radius: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
  }

  .sb-shop-section {
    border: 1px solid #E4D6AC;
    border-radius: 6px;
    padding: 16px;
  }
  .sb-shop-section-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    margin-bottom: 8px;
    cursor: pointer;
    text-align: left;
  }
  .sb-shop-section-chevron {
    color: var(--herb);
    font-size: 12px;
    flex-shrink: 0;
    margin-left: 8px;
  }
  .sb-shop-day-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 12px;
    max-height: 160px;
    overflow-y: auto;
  }
  .sb-shop-day-row {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 13px;
    cursor: pointer;
  }
  .sb-shop-day-row input { flex-shrink: 0; }
  .sb-shop-day-label {
    font-family: 'Inter', sans-serif;
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--herb);
    flex-shrink: 0;
    min-width: 74px;
  }
  .sb-shop-day-recipe { color: var(--ink); }
  .sb-shop-day-actions { display: flex; gap: 8px; flex-wrap: wrap; }

  .sb-shop-add-row { display: flex; gap: 8px; margin-bottom: 14px; }
  .sb-shop-add-row input {
    flex: 1;
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    padding: 9px 10px;
    border: 1px solid #D6C89A;
    border-radius: 4px;
    background: #fff;
    color: var(--ink);
  }

  .sb-shop-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .sb-shop-groups-scroll {
    max-height: 300px;
    overflow-y: auto;
    margin-bottom: 16px;
  }
  .sb-shop-col-headers {
    display: grid;
    grid-template-columns: 40px 40px 1fr 20px;
    gap: 8px;
    padding: 0 4px 6px;
  }
  .sb-shop-col-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: #8a8168;
    text-align: center;
  }
  .sb-shop-section-group { margin-bottom: 10px; }
  .sb-shop-section-title {
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--herb);
    padding: 8px 4px 4px;
    border-top: 1px solid #E4D6AC;
  }
  .sb-shop-section-group:first-child .sb-shop-section-title { border-top: none; padding-top: 0; }
  .sb-shop-item-row {
    display: grid;
    grid-template-columns: 40px 40px 1fr 20px;
    align-items: center;
    gap: 8px;
    padding: 6px 4px;
    border-bottom: 1px solid #E4D6AC;
  }
  .sb-check {
    appearance: none;
    -webkit-appearance: none;
    justify-self: center;
    width: 30px;
    height: 30px;
    margin: 0;
    border-radius: 7px;
    border: 2px solid #C7BFA0;
    background: #fff;
    position: relative;
    cursor: pointer;
    flex-shrink: 0;
    touch-action: manipulation;
  }
  .sb-check::after {
    content: "";
    position: absolute;
    left: 9px;
    top: 4px;
    width: 7px;
    height: 14px;
    border: solid #fff;
    border-width: 0 3px 3px 0;
    transform: rotate(40deg);
    opacity: 0;
  }
  .sb-check:checked::after { opacity: 1; }
  .sb-check-home:checked { background: var(--marigold); border-color: var(--marigold); }
  .sb-check-store:checked { background: var(--herb); border-color: var(--herb); }
  .sb-shop-item-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .sb-shop-item-text { font-size: 14px; color: var(--ink); }
  .sb-shop-item-have { color: #8a8168; font-style: italic; }
  .sb-shop-item-sources {
    font-size: 11px;
    color: var(--herb);
    font-weight: 600;
  }
  .sb-shop-item-checked .sb-shop-item-text { text-decoration: line-through; color: #a39c82; }
  .sb-shop-item-checked .sb-shop-item-sources { color: #b7ae90; }
  .sb-shop-item-remove {
    background: none;
    border: none;
    color: #a39c82;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
  }
  .sb-shop-item-remove:hover { color: var(--tomato); }

  .sb-settings-add {
    border: 1px solid #E4D6AC;
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 6px;
  }
  .sb-settings-users {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
  }
  .sb-settings-user-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    background: #fff;
    border: 1px solid #E4D6AC;
    border-radius: 6px;
    flex-wrap: wrap;
  }
  .sb-settings-user-email { font-size: 13px; font-weight: 600; color: var(--ink); }
  .sb-settings-user-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .sb-settings-inline-edit { display: flex; gap: 8px; align-items: center; flex: 1; flex-wrap: wrap; }
  .sb-settings-inline-edit input {
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    padding: 7px 9px;
    border: 1px solid #D6C89A;
    border-radius: 4px;
    flex: 1;
    min-width: 160px;
  }

  .sb-btn-solid, .sb-btn-ghost, .sb-btn-ghost-light {
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 700;
    padding: 11px 18px;
    border-radius: 5px;
    cursor: pointer;
    border: none;
  }
  .sb-btn-solid { background: var(--herb); color: #fff; }
  .sb-btn-solid:hover { background: #436a4f; }
  .sb-btn-solid:disabled { opacity: 0.4; cursor: not-allowed; }
  .sb-btn-small { padding: 7px 12px; font-size: 12px; }
  .sb-btn-ghost { background: none; border: 1px solid #C9BE9E; color: #6b6250; }
  .sb-btn-ghost-light { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.25); color: #F5EAC8; }
  .sb-btn-danger { color: var(--tomato); border-color: #E2B3A7; }

  .sb-cork {
    background: var(--cork);
    background-image: radial-gradient(rgba(0,0,0,0.08) 1px, transparent 1px);
    background-size: 8px 8px;
    padding: 22px 20px 26px;
  }
  .sb-calendar-grid {
    display: grid;
    grid-template-columns: repeat(7, minmax(120px, 1fr));
    gap: 14px;
  }
  .sb-day-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .sb-day-col-hover {
    outline: 2px solid var(--herb);
    outline-offset: 4px;
    border-radius: 8px;
  }
  .sb-day-col-past { opacity: 0.55; }
  .sb-slot-past {
    width: 100%;
    min-height: 150px;
    border: 2px dashed rgba(58,42,22,0.25);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(58,42,22,0.4);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .sb-day-label {
    display: flex;
    flex-direction: column;
    align-items: center;
    color: #3a2a16;
  }
  .sb-day-name {
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    line-height: 1;
  }
  .sb-day-date { font-size: 11px; font-weight: 600; opacity: 0.75; }
  .sb-day-label-today .sb-day-name { color: var(--tomato); }
  .sb-day-label-today .sb-day-date { color: var(--tomato); }

  .sb-slot-empty {
    width: 100%;
    min-height: 150px;
    border: 2px dashed rgba(58,42,22,0.4);
    border-radius: 6px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    cursor: pointer;
    color: rgba(58,42,22,0.55);
    background: rgba(255,255,255,0.08);
  }
  .sb-slot-empty:hover { background: rgba(255,255,255,0.18); }
  .sb-slot-empty-hover {
    background: rgba(79,122,91,0.25) !important;
    border-color: var(--herb) !important;
    color: var(--herb) !important;
  }
  .sb-slot-plus { font-size: 22px; font-weight: 700; line-height: 1; }
  .sb-slot-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }

  .sb-card {
    background: var(--card);
    border: 1px solid var(--card-edge);
    border-radius: 4px;
    padding: 14px 14px 14px 26px;
    position: relative;
    cursor: pointer;
    width: 100%;
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
    touch-action: manipulation;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
  }
  .sb-card-pinned {
    cursor: grab;
    touch-action: none;
  }
  .sb-card-drag-handle {
    position: absolute;
    top: 10px;
    right: 10px;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    color: #8a8168;
    font-size: 16px;
    cursor: grab;
    touch-action: none;
    -webkit-user-select: none;
    user-select: none;
  }
  .sb-card-drag-handle:hover { background: rgba(79,122,91,0.1); color: var(--herb); }
  .sb-card * {
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }
  .sb-card-dragging {
    opacity: 0.35;
  }

  .sb-drag-ghost {
    position: fixed;
    top: 0;
    left: 0;
    transform: translate(-50%, -130%);
    pointer-events: none;
    z-index: 200;
    background: var(--card);
    border: 2px solid var(--herb);
    border-radius: 6px;
    padding: 8px 14px;
    box-shadow: 0 8px 20px rgba(0,0,0,0.25);
    max-width: 220px;
  }
  .sb-drag-ghost-label {
    font-family: 'Inter', sans-serif;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: var(--herb);
  }
  .sb-drag-ghost-title {
    font-family: 'Zilla Slab', serif;
    font-weight: 600;
    font-size: 14px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sb-card-pinned {
    transform: rotate(-1.5deg);
    min-height: 150px;
  }
  .sb-card-holes {
    position: absolute;
    left: 8px;
    top: 12px;
    bottom: 12px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .sb-card-holes span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: rgba(0,0,0,0.12);
    box-shadow: inset 0 1px 2px rgba(0,0,0,0.2);
  }
  .sb-tack {
    position: absolute;
    top: -8px;
    left: 50%;
    transform: translateX(-50%);
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--tomato);
    box-shadow: 0 2px 3px rgba(0,0,0,0.3);
  }
  .sb-card-body { display: flex; flex-direction: column; gap: 6px; }
  .sb-card-tags { display: flex; gap: 5px; flex-wrap: wrap; }
  .sb-tag {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--herb);
    border: 1px solid var(--herb);
    border-radius: 10px;
    padding: 2px 7px;
  }
  .sb-tag-custom {
    color: #966718;
    border-color: var(--marigold);
    text-transform: none;
    letter-spacing: 0;
  }
  .sb-card-title {
    font-family: 'Zilla Slab', serif;
    font-weight: 600;
    font-size: 15px;
    margin: 0;
    line-height: 1.25;
    color: var(--ink);
  }
  .sb-card-meta { font-size: 11px; color: #7a6f57; }
  .sb-stars { display: flex; gap: 1px; }
  .sb-star { color: #D8CBA0; }
  .sb-star-filled { color: var(--marigold); }
  .sb-card-remove {
    margin-top: 6px;
    background: none;
    border: none;
    color: var(--tomato);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    cursor: pointer;
    padding: 0;
  }

  .sb-day-card-stack {
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
  }
  .sb-day-carousel {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    width: 100%;
  }
  .sb-day-carousel-arrow {
    background: none;
    border: none;
    color: #3a2a16;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
    padding: 2px 6px;
    touch-action: manipulation;
  }
  .sb-day-carousel-arrow:hover { color: var(--tomato); }
  .sb-day-carousel-dots { display: flex; gap: 5px; }
  .sb-day-carousel-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: none;
    background: rgba(58,42,22,0.3);
    padding: 0;
    cursor: pointer;
    touch-action: manipulation;
  }
  .sb-day-carousel-dot-active { background: var(--tomato); }
  .sb-day-add-more {
    background: none;
    border: none;
    color: #3a2a16;
    opacity: 0.75;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    cursor: pointer;
    padding: 2px 4px;
    touch-action: manipulation;
  }
  .sb-day-add-more:hover { opacity: 1; color: var(--herb); }

  .sb-box-section { padding: 26px 28px 32px; }
  .sb-section-title {
    font-family: 'Zilla Slab', serif;
    font-weight: 700;
    font-size: 24px;
    margin: 0 0 18px;
    color: var(--chalk);
  }
  .sb-box-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    margin-bottom: 14px;
  }
  .sb-search-input {
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    padding: 9px 12px;
    border: 1px solid #D6C89A;
    border-radius: 5px;
    background: #fff;
    color: var(--ink);
    min-width: 220px;
    flex: 1;
  }
  .sb-search-input:focus { outline: none; border-color: var(--herb); }
  .sb-sort-select {
    font-family: 'Inter', sans-serif;
    font-size: 13px;
    font-weight: 600;
    padding: 9px 10px;
    border: 1px solid #D6C89A;
    border-radius: 5px;
    background: #fff;
    color: var(--ink);
    cursor: pointer;
  }
  .sb-filter-rows {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 18px;
  }
  .sb-box-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
  }
  .sb-empty-note { color: #7a6f57; font-size: 13px; }

  .sb-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(43,58,50,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    z-index: 50;
  }
  .sb-sheet {
    background: #FBF6E4;
    border-radius: 8px;
    padding: 28px;
    width: 100%;
    max-width: 560px;
    max-height: 85vh;
    overflow-y: auto;
    position: relative;
  }
  .sb-sheet-close {
    position: absolute;
    top: 16px;
    right: 16px;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: none;
    background: rgba(43,58,50,0.06);
    color: #6b6250;
    font-size: 20px;
    line-height: 1;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .sb-sheet-close:hover { background: rgba(43,58,50,0.12); color: var(--chalk); }
  .sb-sheet-title {
    font-family: 'Zilla Slab', serif;
    font-weight: 700;
    font-size: 24px;
    margin: 0 0 18px;
    padding-right: 36px;
    color: var(--chalk);
  }
  .sb-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: var(--herb);
    margin-bottom: 14px;
  }
  .sb-field-wide { width: 100%; }
  .sb-url-actions {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 6px;
  }
  .sb-source-link {
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    font-weight: 700;
    text-transform: none;
    letter-spacing: normal;
    color: var(--herb);
    text-decoration: underline;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .sb-source-link:hover { color: #365e42; }
  .sb-import-note {
    font-size: 12px;
    color: var(--herb);
    font-weight: 600;
    margin: 8px 0 0;
  }

  .sb-photo-field {
    border: 1px solid #D6C89A;
    border-radius: 6px;
    padding: 12px;
    background: #FAFBFD;
  }
  .sb-photo-preview {
    width: 100%;
    max-height: 220px;
    object-fit: cover;
    border-radius: 5px;
    display: block;
    margin-bottom: 10px;
  }
  .sb-photo-placeholder {
    width: 100%;
    height: 90px;
    border: 2px dashed #D6C89A;
    border-radius: 5px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #a39c82;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 700;
    margin-bottom: 10px;
  }
  .sb-photo-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .sb-photo-upload-btn {
    display: inline-flex;
    align-items: center;
    text-transform: none;
    letter-spacing: normal;
    font-weight: 700;
  }

  .sb-card-title-row { display: flex; align-items: center; gap: 8px; }
  .sb-card-thumb {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    object-fit: cover;
    flex-shrink: 0;
  }

  .sb-field input, .sb-field select, .sb-field textarea {
    font-family: 'Inter', sans-serif;
    font-size: 14px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    padding: 9px 10px;
    border: 1px solid #D6C89A;
    border-radius: 4px;
    background: #fff;
    color: var(--ink);
    resize: vertical;
  }
  .sb-field input:focus, .sb-field select:focus, .sb-field textarea:focus {
    outline: none;
    border-color: var(--herb);
  }
  .sb-textarea-large {
    min-height: 190px;
    line-height: 1.5;
    white-space: pre-wrap;
  }
  .sb-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .sb-recipe-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
    border-bottom: 1px solid #E4D6AC;
  }
  .sb-recipe-tab {
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: #8a8168;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 8px 4px;
    margin-bottom: -1px;
    cursor: pointer;
  }
  .sb-recipe-tab + .sb-recipe-tab { margin-left: 12px; }
  .sb-recipe-tab-active {
    color: var(--herb);
    border-bottom-color: var(--herb);
  }
  .sb-form-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }

  .sb-tag-input-row { display: flex; gap: 8px; }
  .sb-tag-input-row input { flex: 1; }
  .sb-tag-editable {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
    color: #966718;
    background: #FBF0D6;
    border: 1px solid var(--marigold);
    border-radius: 14px;
    padding: 5px 6px 5px 12px;
  }
  .sb-tag-remove {
    background: none;
    border: none;
    color: #966718;
    font-size: 15px;
    line-height: 1;
    cursor: pointer;
    padding: 0 4px;
  }
  .sb-tag-remove:hover { color: var(--tomato); }
  .sb-sheet-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-top: 1px solid #E4D6AC;
    padding-top: 16px;
    margin-top: 6px;
  }
  .sb-sheet-actions-right { display: flex; gap: 10px; }
  .sb-shop-clear-actions { display: flex; gap: 10px; flex-wrap: wrap; }

  .sb-quiz-block { margin-bottom: 18px; }
  .sb-quiz-question {
    font-family: 'Zilla Slab', serif;
    font-weight: 600;
    font-size: 15px;
    margin-bottom: 8px;
    color: var(--ink);
  }
  .sb-chip-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .sb-chip {
    font-family: 'Inter', sans-serif;
    font-size: 12px;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: 16px;
    border: 1px solid #D6C89A;
    background: #fff;
    color: var(--ink);
    cursor: pointer;
  }
  .sb-chip-active { background: var(--herb); border-color: var(--herb); color: #fff; }
  .sb-quiz-cta { width: 100%; margin-bottom: 4px; }

  .sb-quiz-results, .sb-assign-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 16px; }
  .sb-quiz-result {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: #fff;
    border: 1px solid #E4D6AC;
    border-radius: 6px;
    cursor: pointer;
  }
  .sb-quiz-result-title { font-family: 'Zilla Slab', serif; font-weight: 600; font-size: 15px; margin: 2px 0; }

  /* ---------- Mobile (iPhone-width) overrides ---------- */
  * { -webkit-tap-highlight-color: transparent; }
  .sb-slot-empty, .sb-chip, .sb-btn-solid, .sb-btn-ghost, .sb-btn-ghost-light, .sb-btn-icon, .sb-star, .sb-quiz-result {
    touch-action: manipulation;
  }

  @media (max-width: 640px) {
    .sb-app { border-radius: 0; }

    .sb-header {
      padding: 20px 16px 18px;
      flex-direction: column;
      align-items: stretch;
      gap: 14px;
    }
    .sb-title { font-size: 27px; }
    .sb-header-actions { display: flex; gap: 8px; }
    .sb-header-actions .sb-btn-ghost-light,
    .sb-header-actions .sb-btn-solid {
      flex: 1;
      padding: 13px 10px;
      text-align: center;
    }

    .sb-cork { padding: 16px 12px 20px; }
    .sb-calendar-grid {
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .sb-day-col {
      flex-direction: row;
      align-items: center;
      gap: 12px;
      width: 100%;
    }
    .sb-day-label {
      flex-direction: row;
      gap: 6px;
      align-items: baseline;
      min-width: 74px;
      flex-shrink: 0;
    }
    .sb-day-name { font-size: 13px; }
    .sb-day-date { font-size: 11px; }
    .sb-slot-empty {
      flex: 1;
      min-height: 64px;
      flex-direction: row;
      gap: 8px;
    }
    .sb-slot-past { flex: 1; min-height: 64px; }
    .sb-card { width: 100%; }
    .sb-day-card-stack { flex: 1; min-width: 0; }
    .sb-card-pinned {
      flex: 1;
      min-height: 0;
      transform: none;
      padding: 12px 12px 12px 24px;
    }
    .sb-tack { display: none; }

    .sb-box-section { padding: 22px 16px 28px; }
    .sb-section-title { font-size: 21px; }
    .sb-box-toolbar { flex-direction: column; align-items: stretch; }
    .sb-search-input { min-width: 0; padding: 12px; font-size: 16px; }
    .sb-sort-select { width: 100%; padding: 12px 10px; font-size: 15px; }
    .sb-box-toolbar .sb-btn-small { width: 100%; padding: 12px; }
    .sb-box-grid { grid-template-columns: 1fr; }

    .sb-chip { padding: 9px 14px; font-size: 13px; }

    .sb-modal-backdrop { padding: 0; align-items: flex-end; }
    .sb-sheet {
      max-width: 100%;
      width: 100%;
      max-height: 92vh;
      border-radius: 14px 14px 0 0;
      padding: 20px 16px calc(20px + env(safe-area-inset-bottom, 0px));
    }
    .sb-sheet-title { font-size: 21px; }
    .sb-form-grid { grid-template-columns: 1fr; gap: 12px; }
    .sb-field input, .sb-field select, .sb-field textarea { font-size: 16px; padding: 11px 10px; }
    .sb-sheet-actions { flex-direction: column-reverse; align-items: stretch; gap: 10px; }
    .sb-sheet-actions-right { display: flex; flex-direction: column-reverse; gap: 10px; width: 100%; }
    .sb-sheet-actions-right .sb-btn-solid,
    .sb-sheet-actions-right .sb-btn-ghost,
    .sb-sheet-actions > .sb-btn-ghost { width: 100%; padding: 13px; }

    .sb-quiz-result { padding: 12px; }
    .sb-quiz-result .sb-btn-solid { flex-shrink: 0; }

    .sb-stars { gap: 3px; }
    .sb-star { font-size: 19px; padding: 2px; }
  }
`;
