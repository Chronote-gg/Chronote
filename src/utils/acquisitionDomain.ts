// Only fixed categories may leave the app. Arbitrary registrable domains can
// identify people too, so unknown hosts are omitted rather than shortened.
const ACQUISITION_DOMAINS = [
  "chatgpt.com",
  "openai.com",
  "claude.ai",
  "perplexity.ai",
  "discord.com",
  "discord.gg",
  "github.com",
  "github.io",
  "google.com",
  "bing.com",
  "reddit.com",
  "producthunt.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "youtube.com",
];

export function sanitizeAcquisitionDomain(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const hostname = value.trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253) return undefined;
  try {
    if (new URL(`https://${hostname}`).hostname !== hostname) return undefined;
  } catch {
    return undefined;
  }
  return ACQUISITION_DOMAINS.find(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
}
