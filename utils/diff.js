function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    Object.keys(value)
      .sort()
      .forEach((k) => {
        out[k] = sortDeep(value[k]);
      });
    return out;
  }
  return value;
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(sortDeep(value));
  } catch (e) {
    return String(value);
  }
}

function diffChangedTopLevelKeys(beforeObj, afterObj) {
  const before = beforeObj && typeof beforeObj === 'object' ? beforeObj : {};
  const after = afterObj && typeof afterObj === 'object' ? afterObj : {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [];
  keys.forEach((k) => {
    if (stableStringify(before[k]) !== stableStringify(after[k])) changed.push(k);
  });
  return changed;
}

function normalizeTopLevelArrayMap(obj) {
  const source = obj && typeof obj === 'object' ? obj : {};
  const normalized = {};
  Object.keys(source).forEach((key) => {
    const value = source[key];
    if (!Array.isArray(value) || value.length === 0) return;
    normalized[key] = value;
  });
  return normalized;
}

function getArrayCountByKey(obj, key) {
  if (!obj || typeof obj !== 'object') return 0;
  return Array.isArray(obj[key]) ? obj[key].length : 0;
}

function buildCollectionChangeMessage(labelSingular, labelPlural, beforeCount, afterCount) {
  const before = Math.max(0, Number(beforeCount) || 0);
  const after = Math.max(0, Number(afterCount) || 0);
  if (after > before) {
    const delta = after - before;
    return delta === 1 ? `${labelSingular} added.` : `${delta} ${labelPlural} added.`;
  }
  if (after < before) {
    const delta = before - after;
    return delta === 1 ? `${labelSingular} removed.` : `${delta} ${labelPlural} removed.`;
  }
  return `${labelPlural.charAt(0).toUpperCase()}${labelPlural.slice(1)} updated (${after}).`;
}

module.exports = {
  sortDeep,
  stableStringify,
  diffChangedTopLevelKeys,
  normalizeTopLevelArrayMap,
  getArrayCountByKey,
  buildCollectionChangeMessage,
};

