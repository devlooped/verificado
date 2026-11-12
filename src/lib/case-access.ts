export type CaseUser = { sub?: string; email?: string; email_verified?: boolean; roles?: unknown };

export const BETA_MESSAGE = "Che.bot está en beta. Para pedir una evaluación, enviá un correo a hola@che.bot.";

export function canRequestCase(user: CaseUser | null | undefined): boolean {
  return !!user?.sub && user.email_verified === true && user.email?.toLowerCase() === "daniel@cazzulino.com";
}

// The exact Admin role, as issued; never a case-insensitive or partial match.
export function isAdmin(user: CaseUser | null | undefined): user is CaseUser & { sub: string } {
  return !!user?.sub && Array.isArray(user.roles) && user.roles.includes("Admin");
}

// Contrib sees the admin page read-only; every change on it still requires isAdmin.
export function canViewAdmin(user: CaseUser | null | undefined): user is CaseUser & { sub: string } {
  return !!user?.sub && Array.isArray(user.roles) && (user.roles.includes("Contrib") || user.roles.includes("Admin"));
}

export function canViewCaseCost(user: CaseUser | null | undefined): boolean {
  return !!user?.sub && Array.isArray(user.roles) && (user.roles.includes("Contrib") || user.roles.includes("Admin"));
}

export function canDeleteCase(user: CaseUser | null | undefined): boolean {
  return isAdmin(user);
}
