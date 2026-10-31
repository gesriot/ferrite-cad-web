/** RFC 9562 UUID version 7. 48-bit unix time, then random bits. Not a v4. */
let lastMs = 0;
let sequence = 0;

export function uuidV7(now = Date.now()): Uint8Array {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  if (now === lastMs) sequence = (sequence + 1) & 0xfff;
  else {
    lastMs = now;
    sequence = (bytes[6]! & 0x0f) << 8 | bytes[7]!;
  }
  bytes[0] = Math.floor(now / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(now / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(now / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(now / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(now / 2 ** 8) & 0xff;
  bytes[5] = now & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}
