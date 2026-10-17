// Browser calling needs the preview voice line; production serves phone-only.
const PHONE_ONLY_HOSTS = ['legacyai.space', 'www.legacyai.space'];
export function browserCallingEnabled(hostname) {
  return !PHONE_ONLY_HOSTS.includes(String(hostname || '').toLowerCase());
}
