function throwNotAvailable() {
  throw new Error('The iconv module is not available');
}

exports.Iconv = throwNotAvailable;
