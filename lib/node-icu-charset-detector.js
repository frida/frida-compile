function throwNotAvailable() {
  throw new Error('The ICU charset detector module is not available');
}

module.exports = {
  detectCharset: throwNotAvailable,
  detectCharsetStream: throwNotAvailable,
  CharsetMatch: throwNotAvailable
};
