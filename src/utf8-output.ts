/** A byte cursor must not split a UTF-8 code point, even for a caller-supplied offset. */
export function utf8Output(bytes: Buffer, offset = 0, limit = bytes.length) {
  let start = Math.min(bytes.length, Math.max(0, offset));
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  let end = Math.min(bytes.length, start + limit);
  while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  if (end === start && start < bytes.length) {
    end++;
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end++;
  }
  if (end > start) {
    let last = end - 1;
    while (last > start && (bytes[last] & 0xc0) === 0x80) last--;
    const lead = bytes[last];
    const width = lead >= 0xf0 && lead <= 0xf4 ? 4 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xc2 && lead <= 0xdf ? 2 : 1;
    if (last + width > end) end = last;
  }
  return { content: bytes.subarray(start, end).toString('utf8'), nextOffset: end, truncated: end < bytes.length };
}
