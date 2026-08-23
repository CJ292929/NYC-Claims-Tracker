import { AXIOS_TIMEOUT_MS, COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { ForbiddenError } from "@shared/_core/errors";
import axios, { type AxiosInstance } from "axios";
import { parse as parseCookieHeader } from "cookie";
import type { Request } from "express";
import { SignJWT, jwtVerify } from "jose";
import type { User } from "../../drizzle/schema";
import * as db from "../db";
import { ENV } from "./env";
import type {
  ExchangeTokenRequest,
  ExchangeTokenResponse,
  GetUserInfoResponse,
  GetUserInfoWithJwtRequest,
  GetUserInfoWithJwtResponse,
} from "./types/manusTypes";
// Utility function
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export type SessionPayload = {
  openId: string;
  appId: string;
  name: string;
};

/** Extra claims present only on clinic staff sessions — owner OAuth sessions
 * never carry these, so `signSession` omits them entirely unless passed. */
export type ClinicSessionClaims = {
  authType: "clinic";
  clinicUserId: string;
  tokenVersion: number;
};

export type VerifiedOwnerSession = { openId: string; appId: string; name: string; authType?: undefined };
export type VerifiedClinicSession = {
  openId: string;
  appId: string;
  name: string;
  authType: "clinic";
  clinicUserId: string;
  tokenVersion: number;
};
export type VerifiedSession = VerifiedOwnerSession | VerifiedClinicSession;

/** Safe, client-facing subset of a clinic_users row — never includes
 * passwordHash or tokenVersion (see auth.me / S2 session architecture notes). */
export type ClinicStaffInfo = {
  clinicUserId: string;
  username: string;
  name: string | null;
  email: string | null;
  department: string | null;
  role: "admin" | "staff";
  mustChangePassword: boolean;
};

const EXCHANGE_TOKEN_PATH = `/webdev.v1.WebDevAuthPublicService/ExchangeToken`;
const GET_USER_INFO_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfo`;
const GET_USER_INFO_WITH_JWT_PATH = `/webdev.v1.WebDevAuthPublicService/GetUserInfoWithJwt`;

class OAuthService {
  constructor(private client: ReturnType<typeof axios.create>) {
    console.log("[OAuth] Initialized with baseURL:", ENV.oAuthServerUrl);
    if (!ENV.oAuthServerUrl) {
      console.error(
        "[OAuth] ERROR: OAUTH_SERVER_URL is not configured! Set OAUTH_SERVER_URL environment variable."
      );
    }
  }

  private decodeState(state: string): string {
    const redirectUri = atob(state);
    return redirectUri;
  }

  async getTokenByCode(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    const payload: ExchangeTokenRequest = {
      clientId: ENV.appId,
      grantType: "authorization_code",
      code,
      redirectUri: this.decodeState(state),
    };

    const { data } = await this.client.post<ExchangeTokenResponse>(
      EXCHANGE_TOKEN_PATH,
      payload
    );

    return data;
  }

  async getUserInfoByToken(
    token: ExchangeTokenResponse
  ): Promise<GetUserInfoResponse> {
    const { data } = await this.client.post<GetUserInfoResponse>(
      GET_USER_INFO_PATH,
      {
        accessToken: token.accessToken,
      }
    );

    return data;
  }
}

const createOAuthHttpClient = (): AxiosInstance =>
  axios.create({
    baseURL: ENV.oAuthServerUrl,
    timeout: AXIOS_TIMEOUT_MS,
  });

class SDKServer {
  private readonly client: AxiosInstance;
  private readonly oauthService: OAuthService;

  constructor(client: AxiosInstance = createOAuthHttpClient()) {
    this.client = client;
    this.oauthService = new OAuthService(this.client);
  }

  private deriveLoginMethod(
    platforms: unknown,
    fallback: string | null | undefined
  ): string | null {
    if (fallback && fallback.length > 0) return fallback;
    if (!Array.isArray(platforms) || platforms.length === 0) return null;
    const set = new Set<string>(
      platforms.filter((p): p is string => typeof p === "string")
    );
    if (set.has("REGISTERED_PLATFORM_EMAIL")) return "email";
    if (set.has("REGISTERED_PLATFORM_GOOGLE")) return "google";
    if (set.has("REGISTERED_PLATFORM_APPLE")) return "apple";
    if (
      set.has("REGISTERED_PLATFORM_MICROSOFT") ||
      set.has("REGISTERED_PLATFORM_AZURE")
    )
      return "microsoft";
    if (set.has("REGISTERED_PLATFORM_GITHUB")) return "github";
    const first = Array.from(set)[0];
    return first ? first.toLowerCase() : null;
  }

  /**
   * Exchange OAuth authorization code for access token
   * @example
   * const tokenResponse = await sdk.exchangeCodeForToken(code, state);
   */
  async exchangeCodeForToken(
    code: string,
    state: string
  ): Promise<ExchangeTokenResponse> {
    return this.oauthService.getTokenByCode(code, state);
  }

  /**
   * Get user information using access token
   * @example
   * const userInfo = await sdk.getUserInfo(tokenResponse.accessToken);
   */
  async getUserInfo(accessToken: string): Promise<GetUserInfoResponse> {
    const data = await this.oauthService.getUserInfoByToken({
      accessToken,
    } as ExchangeTokenResponse);
    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoResponse;
  }

  private parseCookies(cookieHeader: string | undefined) {
    if (!cookieHeader) {
      return new Map<string, string>();
    }

    const parsed = parseCookieHeader(cookieHeader);
    return new Map(Object.entries(parsed));
  }

  private getSessionSecret() {
    const secret = ENV.cookieSecret;
    return new TextEncoder().encode(secret);
  }

  /**
   * Create a session token for a Manus user openId
   * @example
   * const sessionToken = await sdk.createSessionToken(userInfo.openId);
   */
  async createSessionToken(
    openId: string,
    options: { expiresInMs?: number; name?: string } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId,
        appId: ENV.appId,
        name: options.name || "",
      },
      options
    );
  }

  async signSession(
    payload: SessionPayload & Partial<ClinicSessionClaims>,
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    const issuedAt = Date.now();
    const expiresInMs = options.expiresInMs ?? ONE_YEAR_MS;
    const expirationSeconds = Math.floor((issuedAt + expiresInMs) / 1000);
    const secretKey = this.getSessionSecret();

    // Owner OAuth sessions pass no clinic claims, so their JWT payload stays
    // byte-for-byte identical to pre-S2 tokens ({openId, appId, name} only).
    const claims: Record<string, unknown> = {
      openId: payload.openId,
      appId: payload.appId,
      name: payload.name,
    };
    if (payload.authType === "clinic") {
      claims.authType = payload.authType;
      claims.clinicUserId = payload.clinicUserId;
      claims.tokenVersion = payload.tokenVersion;
    }

    return new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setExpirationTime(expirationSeconds)
      .sign(secretKey);
  }

  /** Create a clinic staff session carrying the staff identity + token_version
   * needed to enforce archived/stale-session checks on every request. */
  async createClinicSessionToken(
    params: { clinicUserId: string; username: string; tokenVersion: number },
    options: { expiresInMs?: number } = {}
  ): Promise<string> {
    return this.signSession(
      {
        openId: `clinic_${params.username}`,
        appId: ENV.appId,
        name: params.username,
        authType: "clinic",
        clinicUserId: params.clinicUserId,
        tokenVersion: params.tokenVersion,
      },
      options
    );
  }

  async verifySession(
    cookieValue: string | undefined | null
  ): Promise<VerifiedSession | null> {
    if (!cookieValue) {
      console.warn("[Auth] Missing session cookie");
      return null;
    }

    try {
      const secretKey = this.getSessionSecret();
      const { payload } = await jwtVerify(cookieValue, secretKey, {
        algorithms: ["HS256"],
      });
      const { openId, appId, name, authType, clinicUserId, tokenVersion } =
        payload as Record<string, unknown>;

      if (
        !isNonEmptyString(openId) ||
        !isNonEmptyString(appId) ||
        !isNonEmptyString(name)
      ) {
        console.warn("[Auth] Session payload missing required fields");
        return null;
      }

      if (authType === "clinic") {
        if (!isNonEmptyString(clinicUserId) || typeof tokenVersion !== "number") {
          console.warn("[Auth] Clinic session payload missing required fields");
          return null;
        }
        return { openId, appId, name, authType: "clinic", clinicUserId, tokenVersion };
      }

      return { openId, appId, name };
    } catch (error) {
      console.warn("[Auth] Session verification failed", String(error));
      return null;
    }
  }

  async getUserInfoWithJwt(
    jwtToken: string
  ): Promise<GetUserInfoWithJwtResponse> {
    const payload: GetUserInfoWithJwtRequest = {
      jwtToken,
      projectId: ENV.appId,
    };

    const { data } = await this.client.post<GetUserInfoWithJwtResponse>(
      GET_USER_INFO_WITH_JWT_PATH,
      payload
    );

    const loginMethod = this.deriveLoginMethod(
      (data as any)?.platforms,
      (data as any)?.platform ?? data.platform ?? null
    );
    return {
      ...(data as any),
      platform: loginMethod,
      loginMethod,
    } as GetUserInfoWithJwtResponse;
  }

  async authenticateRequest(req: Request): Promise<AuthenticatedUser> {
    // Regular authentication flow
    const cookies = this.parseCookies(req.headers.cookie);
    const sessionCookie = cookies.get(COOKIE_NAME);
    const session = await this.verifySession(sessionCookie);

    if (!session) {
      throw ForbiddenError("Invalid session cookie");
    }

    if (session.authType === "clinic") {
      return this.authenticateClinicSession(session);
    }

    if (session.openId.startsWith(CRON_OPEN_ID_PREFIX)) {
      const userInfo = await this.getUserInfoWithJwt(sessionCookie ?? "");
      const taskUid = userInfo.taskUid ?? null;
      if (!taskUid) {
        throw ForbiddenError("Cron session missing task_uid");
      }
      return buildCronUser(userInfo);
    }

    const sessionUserId = session.openId;
    const signedInAt = new Date();
    let user = await db.getUserByOpenId(sessionUserId);

    // If user not in DB, sync from OAuth server automatically
    if (!user) {
      try {
        const userInfo = await this.getUserInfoWithJwt(sessionCookie ?? "");
        await db.upsertUser({
          openId: userInfo.openId,
          name: userInfo.name || null,
          email: userInfo.email ?? null,
          loginMethod: userInfo.loginMethod ?? userInfo.platform ?? null,
          lastSignedIn: signedInAt,
        });
        user = await db.getUserByOpenId(userInfo.openId);
      } catch (error) {
        console.error("[Auth] Failed to sync user from OAuth:", error);
        throw ForbiddenError("Failed to sync user info");
      }
    }

    if (!user) {
      throw ForbiddenError("User not found");
    }

    await db.upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt,
    });

    return user;
  }

  /** Resolves a clinic staff session against the current clinic_users row on
   * every request — this is what makes archived accounts and stale
   * token_version reject already-issued sessions, not just new logins. */
  private async authenticateClinicSession(
    session: VerifiedClinicSession
  ): Promise<AuthenticatedUser> {
    const clinicUser = await db.getClinicUserById(session.clinicUserId);
    if (!clinicUser) {
      throw ForbiddenError("Clinic session invalid");
    }
    if (clinicUser.status !== "active") {
      throw ForbiddenError("Account is not active");
    }
    if (clinicUser.tokenVersion !== session.tokenVersion) {
      throw ForbiddenError("Session expired, please sign in again");
    }

    // Preserve the existing clinic_${username} -> public.users bridge so the
    // rest of the app (which resolves ctx.user from public.users) keeps
    // working unchanged. clinic_users remains the authority for identity,
    // status, role, must_change_password, and token_version.
    const signedInAt = new Date();
    const syntheticOpenId = session.openId;
    let user = await db.getUserByOpenId(syntheticOpenId);
    if (!user) {
      await db.upsertUser({
        openId: syntheticOpenId,
        name: clinicUser.username,
        email: null,
        loginMethod: "password",
        lastSignedIn: signedInAt,
      });
      user = await db.getUserByOpenId(syntheticOpenId);
    }
    if (!user) {
      throw ForbiddenError("User not found");
    }

    await db.upsertUser({
      openId: user.openId,
      lastSignedIn: signedInAt,
    });

    const clinicStaffInfo: ClinicStaffInfo = {
      clinicUserId: clinicUser.id,
      username: clinicUser.username,
      name: clinicUser.name,
      email: clinicUser.email,
      department: clinicUser.department,
      role: clinicUser.role,
      mustChangePassword: clinicUser.mustChangePassword,
    };

    return { ...user, clinicUser: clinicStaffInfo };
  }
}

const CRON_OPEN_ID_PREFIX = "cron_";

/** Result of `sdk.authenticateRequest`. Cron callbacks set `isCron=true` and `taskUid`;
 * see `references/periodic-updates.md`. Clinic staff sessions set `clinicUser` — its
 * presence is how the rest of the app distinguishes clinic staff from owner OAuth. */
export type AuthenticatedUser = User & {
  taskUid?: string;
  isCron?: boolean;
  clinicUser?: ClinicStaffInfo;
};

function buildCronUser(
  userInfo: GetUserInfoWithJwtResponse
): AuthenticatedUser {
  const now = new Date();
  return {
    id: "00000000-0000-0000-0000-000000000000",
    openId: userInfo.openId,
    name: userInfo.name || "Manus Scheduled Task",
    email: null,
    loginMethod: null,
    role: "user",
    createdAt: now,
    updatedAt: now,
    lastSignedIn: now,
    taskUid: userInfo.taskUid ?? undefined,
    isCron: true,
  } as AuthenticatedUser;
}

export const sdk = new SDKServer();
