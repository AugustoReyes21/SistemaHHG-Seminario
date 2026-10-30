/**
 * Helpers to normalize user input before storing or comparing.
 */
function normalizeText(value) {
  if (value == null) return '';
  return String(value)
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeBarcode(value) {
  return normalizeText(value)
    .toLowerCase();
}

module.exports = {
  normalizeText,
  normalizeBarcode
};
