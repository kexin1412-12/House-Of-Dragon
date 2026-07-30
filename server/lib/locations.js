const fs = require('fs');
const path = require('path');
const kbPaths = require('./kb-paths');

const cache = new Map();

function loadLocationDb(showId) {
  if (!showId) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(showId)) return null;
  if (cache.has(showId)) return cache.get(showId);
  const file = kbPaths.locations(showId);
  if (!fs.existsSync(file)) {
    cache.set(showId, null);
    return null;
  }
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(showId, db);
  return db;
}

function clearCache(showId = null) {
  if (showId) cache.delete(showId);
  else cache.clear();
}

function normalizeLocationName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[\s·,，。:：/\\()（）\-_]+/g, '');
}

function findLocation(db, locationId) {
  return (db?.locations || []).find(location => location.location_id === locationId) || null;
}

function candidateNames(location) {
  return [
    location.location_id,
    location.canonical_name,
    location.display_name_zh,
    ...(Array.isArray(location.aliases) ? location.aliases : []),
  ].filter(Boolean);
}

function resolveLocation(db, query) {
  const normalized = normalizeLocationName(query);
  if (!db || !normalized) return null;

  const candidates = [];
  for (const location of db.locations || []) {
    for (const name of candidateNames(location)) {
      const key = normalizeLocationName(name);
      if (!key) continue;
      if (key === normalized) {
        return { location, confidence: 'high', method: 'exact_alias', matched_alias: name };
      }
      if (key.length >= 2 && normalized.includes(key)) {
        candidates.push({ location, key, matched_alias: name });
      }
    }
  }

  candidates.sort((a, b) => b.key.length - a.key.length);
  if (!candidates.length) return null;
  return {
    location: candidates[0].location,
    confidence: 'medium',
    method: 'contained_alias',
    matched_alias: candidates[0].matched_alias,
  };
}

function locationCard(location) {
  if (!location) return null;
  return {
    location_id: location.location_id,
    display_name: location.display_name_zh || location.canonical_name,
    canonical_name: location.canonical_name || null,
    kind: location.kind || null,
    region: location.region_zh || null,
    parent_location_id: location.parent_location_id || null,
    summary: location.summary_zh || null,
    official_map_entry: location.official_map_entry === true,
    source_class: location.source_class || null,
    first_listed_episode: location.first_listed_episode || null,
    assets: location.assets || null,
  };
}

function resolveSceneLocations(db, scene) {
  if (!db || !scene) return { raw_label: scene?.location || null, locations: [] };
  const ids = [];
  if (Array.isArray(scene.location_ids)) ids.push(...scene.location_ids);
  else if (scene.location_id) ids.push(scene.location_id);

  const cards = ids
    .map(id => locationCard(findLocation(db, id)))
    .filter(Boolean);
  if (cards.length) {
    return {
      raw_label: scene.location || null,
      locations: cards,
      match: scene.location_match || null,
    };
  }

  const resolved = resolveLocation(db, scene.location);
  return {
    raw_label: scene.location || null,
    locations: resolved ? [locationCard(resolved.location)] : [],
    match: resolved ? {
      confidence: resolved.confidence,
      method: resolved.method,
      matched_alias: resolved.matched_alias,
    } : null,
  };
}

function searchLocations(db, query = '', options = {}) {
  if (!db) return [];
  const normalized = normalizeLocationName(query);
  const officialOnly = options.officialOnly === true;
  const parentId = options.parentId || null;
  const limit = Number.isFinite(options.limit) ? options.limit : 100;

  return (db.locations || [])
    .filter(location => !officialOnly || location.official_map_entry === true)
    .filter(location => !parentId || location.parent_location_id === parentId)
    .filter(location => !normalized || candidateNames(location)
      .some(name => normalizeLocationName(name).includes(normalized)))
    .slice(0, limit)
    .map(locationCard);
}

function matchLocationsInText(db, text, options = {}) {
  const normalized = normalizeLocationName(text);
  if (!db || !normalized) return [];
  const limit = Number.isFinite(options.limit) ? options.limit : 8;
  const matches = new Map();

  for (const location of db.locations || []) {
    for (const name of candidateNames(location)) {
      const key = normalizeLocationName(name);
      if (key.length < 2 || !normalized.includes(key)) continue;
      const current = matches.get(location.location_id);
      if (!current || key.length > current.key.length) {
        matches.set(location.location_id, { location, key, matched_alias: name });
      }
    }
  }

  return [...matches.values()]
    .sort((a, b) => b.key.length - a.key.length)
    .slice(0, limit)
    .map(match => ({
      ...locationCard(match.location),
      matched_alias: match.matched_alias,
    }));
}

module.exports = {
  loadLocationDb,
  clearCache,
  normalizeLocationName,
  findLocation,
  resolveLocation,
  resolveSceneLocations,
  searchLocations,
  matchLocationsInText,
  locationCard,
};
