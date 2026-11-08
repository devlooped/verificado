// Cases use the site's Argentine civil day, independent of the server's timezone.
export function caseDate(createdAt: string): string {
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(createdAt)) return createdAt;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(createdAt));
}

export function formatCaseDate(date: string, language: string): string {
  return new Intl.DateTimeFormat(language, { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(date + "T00:00:00Z"));
}

export function caseDateRule(date: string, language: string): string {
  return `The case was created on ${formatCaseDate(date, language)} (${date}, America/Argentina/Buenos_Aires). Resolve relative dates such as "today" in the submitted request against this case date, not the current date. Use the absolute date when restating or explaining such claims, but preserve verbatim quotations. Do not assume it is the publication date of linked or quoted material.`;
}
