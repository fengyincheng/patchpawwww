/**
 * The small, non-secret deployment contract shared by the server and frontend.
 * Keep this DTO deliberately narrower than the runtime configuration: it is
 * served before authentication and must be safe to expose to any visitor.
 */
export interface PublicSetupInfo {
  public_origin: string | null;
  webhook_url: string | null;
  https_enabled: boolean;
  admin_auth_configured: boolean;
}

export function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function publicSetupInfo(publicOrigin: string | null | undefined, adminAuthConfigured: boolean): PublicSetupInfo {
  const origin = normalizeOrigin(publicOrigin);
  return {
    public_origin: origin,
    webhook_url: origin ? new URL('/github/webhook', origin).toString() : null,
    https_enabled: origin?.startsWith('https://') ?? false,
    admin_auth_configured: adminAuthConfigured,
  };
}
