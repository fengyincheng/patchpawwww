export const contextPolicy = {
  version: 'p0-v1', lastMessages: 100, toolOutputTokens: 5000,
  seedChars: 18000, evidencePageChars: 16000, suggestedReadLines: 200,
};
export function excerpt(text: string, limit = contextPolicy.seedChars, offset = 0) {
  const content = text.slice(offset, offset + limit);
  return { content, total_chars: text.length, offset, truncated: offset + content.length < text.length,
    next_offset: offset + content.length < text.length ? offset + content.length : null };
}
export function isOutputTruncated(output: unknown): boolean {
  if (output && typeof output === 'object' && 'truncated' in output) return output.truncated === true;
  return typeof output === 'string' && /\[.*(?:truncated|output capped).*\]|<truncat|Output truncated/i.test(output);
}
