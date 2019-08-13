const caps = {
  level: 3,
  hasBasic: true,
  has256: true,
  has16m: true
};

function supportsColor(stream) {
  return caps;
}

module.exports = {
  supportsColor,
  stdout: caps,
  stderr: caps
};
