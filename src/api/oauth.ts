/** Minimal Discord OAuth2 client (identify scope only). Injectable so tests can fake Discord. */

export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
}

export interface OAuthClient {
  authorizeUrl(state: string): string;
  /** Exchange an authorization code and return the user it belongs to. */
  identify(code: string): Promise<DiscordUser>;
}

const API = 'https://discord.com/api/v10';

export function avatarUrl(user: Pick<DiscordUser, 'id' | 'avatar'>): string | null {
  return user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : null;
}

export class DiscordOAuthClient implements OAuthClient {
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {}

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'identify',
      state,
      prompt: 'none',
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  async identify(code: string): Promise<DiscordUser> {
    const tokenRes = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) throw new Error(`Token exchange failed (${tokenRes.status})`);
    const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };
    const userRes = await fetch(`${API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) throw new Error(`Fetching the Discord user failed (${userRes.status})`);
    // The token is only used for this one lookup; revoke it so it doesn't linger.
    void fetch(`${API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        token: accessToken,
        token_type_hint: 'access_token',
      }),
    }).catch(() => {});
    return (await userRes.json()) as DiscordUser;
  }
}
