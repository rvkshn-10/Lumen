export const COMPARE_LIMIT = 4;

export function compareSiteLetter(index: number) {
  return String.fromCharCode("A".charCodeAt(0) + index);
}

export function compareSiteLabel(index: number) {
  return `Site ${compareSiteLetter(index)}`;
}
