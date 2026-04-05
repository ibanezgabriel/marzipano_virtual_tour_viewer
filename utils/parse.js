function parseOptionalInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  parseOptionalInt,
};

