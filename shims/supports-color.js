const caps = {
  level: 3,
  hasBasic: true,
  has256: true,
  has16m: true
};

export function supportsColor(stream) {
  return caps;
}

export const stdout = caps;
export const stderr = caps;