// Public provider endpoint; no credentials are stored here.
export const authBase = process.env.NEON_AUTH_BASE_URL || 'https://ep-summer-voice-b7ypcxzf.neonauth.c-13.us-east-1.aws.neon.tech/neondb/auth';
// The owner explicitly named this sole sign-in identity.
export const ownerEmail = 'douglastalley1977@gmail.com';
export const model = process.env.CONCIERGE_MODEL || 'anthropic/claude-sonnet-4.6';
