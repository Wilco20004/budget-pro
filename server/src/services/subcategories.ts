import { v4 as uuid } from 'uuid';
import { db } from '../db';
import { applyReceiptSplits } from '../receipts/service';
import { normalizeProductName } from './categorize';

// Subcategories: one level under a parent (Groceries → Meat, Starch, …).

/** Starter slip keywords for common grocery subcategories, keyed by a
 *  normalised name. Added when a subcategory with that name is created;
 *  a keyword that already exists (for any category) is left alone. */
const STARTER_KEYWORDS: Record<string, string[]> = {
  meat: [
    'CHICKEN', 'BEEF', 'MINCE', 'PORK', 'LAMB', 'WORS', 'STEAK', 'BACON', 'POLONY', 'VIENNA', 'RIBS', 'CHOPS', 'SAUSAGE',
    'BILTONG', 'DROEWORS', ' HAM ', 'SALAMI', 'FISH', 'HAKE', 'TUNA', 'DRUMSTICK', 'THIGHS', 'FILLET', 'GAMMON',
  ],
  starch: [
    'BREAD', 'LOAF', 'ROLLS', 'WRAPS', ' RICE', 'PASTA', 'SPAGHETTI', 'MACARONI', 'PENNE', 'NOODLE', 'MAIZE', 'MEALIE',
    ' PAP ', 'SAMP', 'POTATO', 'FLOUR', 'OATS', 'CEREAL', 'WEET BIX', 'WEETBIX', 'CORNFLAKES', 'COUSCOUS',
  ],
  fruitveg: [
    'APPLE', 'APL ', 'BANANA', 'ORANGE', 'NAARTJIE', 'GRAPE', 'PEAR', 'LEMON', 'MANGO', 'PINEAPPLE', 'STRAWBERR', 'BERRIES',
    'AVOCADO', 'TOMATO', 'ONION', 'CARROT', 'LETTUCE', 'SPINACH', 'CUCUMBER', 'BUTTERNUT', 'PUMPKIN', 'SQUASH', 'BABY MARROW',
    'BABY CORN', 'BROCCOLI', 'CAULIFLOWER', 'CABBAGE', 'MUSHROOM', 'SWEET POTATO', 'GREEN BEANS', 'PEPPERS', 'BASIL',
    'PARSLEY', 'CORIANDER', 'GARLIC', 'GINGER',
  ],
  kitchen: [
    ' OIL ', 'SUGAR', 'SALT', 'SPICE', 'PAPRIKA', 'STOCK', 'ROYCO', 'KNORR', 'SAUCE', 'KETCHUP', 'MAYO', 'VINEGAR', 'BAKING',
    'ICING', 'BICARB', 'CORNFLOUR', 'MAIZENA', 'YEAST', 'PESTO', 'COOK IN', 'GRAVY', 'CURRY', 'HERBS', 'COFFEE', ' TEA ',
    'ROOIBOS', 'FOIL', 'CLING', 'WAX WRAP',
  ],
  snacks: [
    'CHIPS', 'CRISPS', 'SIMBA', 'LAYS', 'DORITOS', 'NIKNAK', 'CHEESE CURLS', 'CHOC', 'BAR ONE', 'LUNCHBAR',
    'KIT KAT', 'KITKAT', 'TEX ', 'AERO', 'SWEETS', 'GUMMY', 'JELLY', 'LOLLIPOP', 'BISCUIT', 'COOKIE', 'OREO', 'ROMANY',
    'CUPCAKE', 'MUFFIN', 'DOUGHNUT', 'ICE CREAM', 'POPCORN', 'PRETZEL', 'JUNGLE BAR', 'ENERGY BAR', 'POTATO CHIPS', 'POTATO SNACK', 'SNACK',
  ],
};

function starterKey(name: string): string | null {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (/^(meat|meats|meatfish|meatandfish|protein)$/.test(n)) return 'meat';
  if (/^(starch|starches|bread|breadstarch|carbs)$/.test(n)) return 'starch';
  if (/^(fruitveg|fruitandveg|fruitvegetables|fruitandvegetables|veg|produce|fruitnveg)$/.test(n)) return 'fruitveg';
  if (/^(kitchen|pantry|kitchenpantry|cooking|baking)$/.test(n)) return 'kitchen';
  if (/^(snackssweets|snacksandsweets|snacks|sweets|treats|snacksnsweets)$/.test(n)) return 'snacks';
  return null;
}

/** Adds the starter keywords for a new subcategory. Returns how many. */
export function addStarterKeywords(categoryId: string, name: string): number {
  const key = starterKey(name);
  if (!key) return 0;
  const exists = db.prepare('SELECT 1 FROM category_keywords WHERE upper(keyword) = ?');
  const ins = db.prepare('INSERT INTO category_keywords (id, keyword, category_id) VALUES (?, ?, ?)');
  let n = 0;
  db.transaction(() => {
    for (const kw of STARTER_KEYWORDS[key]) {
      if (exists.get(kw)) continue;
      ins.run(uuid(), kw, categoryId);
      n++;
    }
  })();
  return n;
}

/** Moves slip lines that sit in the parent (or have no category on a slip
 *  whose shop defaults to the parent) into a subcategory when one of the
 *  subcategories' keywords matches, teaches the product, and re-splits the
 *  linked transactions. Lines already in another category are left alone. */
export function resortIntoSubcategories(parentId: string): { lines: number; receipts: number } {
  const children = new Set(
    (db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(parentId) as { id: string }[]).map((c) => c.id)
  );
  // Every keyword competes (longest wins), so TOILET ROLL → Household beats
  // ROLLS → Starch; the line only moves when the winner is a subcategory.
  const keywords = db.prepare('SELECT keyword, category_id FROM category_keywords').all() as { keyword: string; category_id: string }[];
  if (!keywords.some((k) => children.has(k.category_id))) return { lines: 0, receipts: 0 };
  const items = db
    .prepare(
      `SELECT i.id, i.raw_name, i.product_id, i.receipt_id FROM receipt_items i
       JOIN receipts r ON r.id = i.receipt_id
       LEFT JOIN merchants m ON m.id = r.merchant_id
       WHERE i.category_id = ? OR (i.category_id IS NULL AND m.default_category_id = ?)`
    )
    .all(parentId, parentId) as { id: string; raw_name: string; product_id: string | null; receipt_id: string }[];
  const setItem = db.prepare('UPDATE receipt_items SET category_id = ? WHERE id = ?');
  // Only products still unsorted (none, or the parent) learn the subcategory.
  const setProduct = db.prepare('UPDATE products SET category_id = ?, updated_at = ? WHERE id = ? AND (category_id IS NULL OR category_id = ?)');
  const touched = new Set<string>();
  let lines = 0;
  db.transaction(() => {
    for (const it of items) {
      const hay = ` ${normalizeProductName(it.raw_name)} `;
      let best: { keyword: string; category_id: string } | null = null;
      for (const k of keywords) {
        const kw = k.keyword.toUpperCase();
        if (hay.includes(kw) && (!best || kw.length > best.keyword.length)) best = k;
      }
      if (!best || !children.has(best.category_id)) continue;
      setItem.run(best.category_id, it.id);
      if (it.product_id) setProduct.run(best.category_id, new Date().toISOString(), it.product_id, parentId);
      touched.add(it.receipt_id);
      lines++;
    }
  })();
  let receipts = 0;
  for (const id of touched) {
    const r = db.prepare('SELECT transaction_id FROM receipts WHERE id = ?').get(id) as { transaction_id: string | null };
    if (r.transaction_id) {
      applyReceiptSplits(id);
      receipts++;
    }
  }
  return { lines, receipts };
}
