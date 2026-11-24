const forms = Object.freeze({
  numeric: /^\d+(\.\d+){2,3}$/,
  request: /^(\d+(?:\.\d+){2,3})(-preview)?$/
});

export const parseRequest = (text) => {
  const value = String(text).trim().toLowerCase();
  if (value === "latest") {
    return { channel: "release", pin: null };
  }
  if (value === "preview") {
    return { channel: "preview", pin: null };
  }
  const match = value.match(forms.request);
  if (!match) {
    return null;
  }
  return { channel: match[2] ? "preview" : "release", pin: match[1] };
};

export const parseVersion = (text) => (forms.numeric.test(String(text)) ? String(text).split(".").map(Number) : null);

export const engineOf = (text) => {
  const parts = parseVersion(text);
  return parts ? parts.slice(0, 3) : null;
};

export const compareVersions = (left, right) => {
  const a = parseVersion(left) ?? [];
  const b = parseVersion(right) ?? [];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  return 0;
};
