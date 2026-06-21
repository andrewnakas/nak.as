// Server-side sanity validation of character saves. P2P means we trust the
// party during play; this is the line that keeps absurd saves out of D1.
// Bounds mirror the sim's content; the item/quest manifests are bundled in
// at deploy time so legality checks track the shipped content.

import items from '../../game/assets/content/items.json';
import quests from '../../game/assets/content/quests.json';

const ITEM_NAMES = new Set(items.map((i) => i.name));
const QUEST_IDS = new Set(quests.map((q) => q.id));

const LIMITS = {
  maxShells: 1000000,
  maxSkillXp: 10000000,
  // Combat XP cap (generous; the sim caps level at 30 well under this).
  maxXp: 100000000,
  // Heart containers can push max HP above the old base of 40 (sim clamps 60).
  maxHp: 60,
  // The pack is unbounded in play now; this is just a sanity ceiling so a
  // corrupt/hostile save can't store an enormous inventory.
  maxInventory: 512,
  maxQty: 99,
  // Fusing reinforces durability (+10); leave generous headroom.
  maxDurability: 9999,
  maxProgress: 10000,
};

/// Returns null if valid, else a short reason string.
export function validateSave(data) {
  if (typeof data !== 'object' || data === null) return 'not an object';
  if (data.schema_version !== 1) return 'unknown schema_version';

  if (!Number.isInteger(data.hp) || !Number.isInteger(data.max_hp)) return 'bad hp';
  if (data.max_hp < 2 || data.max_hp > LIMITS.maxHp) return 'max_hp out of range';
  if (data.hp < 0 || data.hp > data.max_hp) return 'hp out of range';

  if (!Number.isInteger(data.shells) || data.shells < 0 || data.shells > LIMITS.maxShells) {
    return 'shells out of range';
  }

  // Combat XP is optional (older saves omit it; defaults to 0 in the sim).
  if (data.xp != null && (!Number.isInteger(data.xp) || data.xp < 0 || data.xp > LIMITS.maxXp)) {
    return 'xp out of range';
  }

  if (!Array.isArray(data.skills) || data.skills.length !== 3) return 'bad skills';
  for (const xp of data.skills) {
    if (!Number.isInteger(xp) || xp < 0 || xp > LIMITS.maxSkillXp) return 'skill xp out of range';
  }

  if (!Array.isArray(data.inventory) || data.inventory.length > LIMITS.maxInventory) {
    return 'bad inventory';
  }
  for (const s of data.inventory) {
    if (typeof s !== 'object' || s === null) return 'bad item';
    if (!ITEM_NAMES.has(s.item)) return `unknown item ${s.item}`;
    if (!Number.isInteger(s.qty) || s.qty < 1 || s.qty > LIMITS.maxQty) return 'item qty';
    if (!Number.isInteger(s.durability) || s.durability < 0 || s.durability > LIMITS.maxDurability) {
      return 'item durability';
    }
    if (s.fused != null && !ITEM_NAMES.has(s.fused)) return 'unknown fused item';
    if (s.attached != null && !ITEM_NAMES.has(s.attached)) return 'unknown attached item';
  }

  if (!Array.isArray(data.quests)) return 'bad quests';
  for (const q of data.quests) {
    if (typeof q !== 'object' || q === null) return 'bad quest';
    if (!QUEST_IDS.has(q.id)) return `unknown quest ${q.id}`;
    if (typeof q.done !== 'boolean') return 'bad quest done';
    if (!Array.isArray(q.progress) || q.progress.length > 8) return 'bad quest progress';
    for (const c of q.progress) {
      if (!Number.isInteger(c) || c < 0 || c > LIMITS.maxProgress) return 'quest progress';
    }
  }

  for (const k of ['sx', 'sy', 'x', 'y']) {
    if (!Number.isInteger(data[k]) || Math.abs(data[k]) > 1000) return 'bad position';
  }

  return null;
}
