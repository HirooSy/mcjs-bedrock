const buildTable = () => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
};

export const checksum = (() => {
  const table = buildTable();
  return (previous, chunk) => {
    let value = previous ^ 0xffffffff;
    for (let index = 0; index < chunk.length; index += 1) {
      value = table[(value ^ chunk[index]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
})();
