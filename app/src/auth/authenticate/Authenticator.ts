import { type DB, Exception } from "core";
import { addFlashMessage } from "core/server/flash";
import {
   $console,
   type Static,
   StringEnum,
   type TObject,
   parse,
   runtimeSupports,
   truncate,
} from "core/utils";
import type { Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import type { CookieOptions } from "hono/utils/cookie";
import type { ServerEnv } from "modules/Controller";
import { pick } from "lodash-es";
import * as tbbox from "@sinclair/typebox";
import { InvalidConditionsException } from "auth/errors";
const { Type } = tbbox;

type Input = any; // workaround
export type JWTPayload = Parameters<typeof sign>[0];

export const strategyActions = ["create", "change"] as const;
export type StrategyActionName = (typeof strategyActions)[number];
export type StrategyAction<S extends TObject = TObject> = {
   schema: S;
   preprocess: (input: Static<S>) => Promise<Omit<DB["users"], "id" | "strategy">>;
};
export type StrategyActions = Partial<Record<StrategyActionName, StrategyAction>>;

// @todo: add schema to interface to ensure proper inference
// @todo: add tests (e.g. invalid strategy_value)
export interface Strategy {
   getController: (auth: Authenticator) => Hono<any>;
   getType: () => string;
   getMode: () => "form" | "external";
   getName: () => string;
   toJSON: (secrets?: boolean) => any;
   getActions?: () => StrategyActions;
}

export type User = DB["users"];

export type ProfileExchange = {
   email?: string;
   strategy?: string;
   strategy_value?: string;
   [key: string]: any;
};

export type SafeUser = Omit<User, "strategy_value">;
export type CreateUser = Pick<User, "email"> & { [key: string]: any };
export type AuthResponse = { user: SafeUser; token: string };

export interface UserPool {
   findBy: (strategy: string, prop: keyof SafeUser, value: string | number) => Promise<User>;
   create: (strategy: string, user: CreateUser) => Promise<User>;
}

const defaultCookieExpires = 60 * 60 * 24 * 7; // 1 week in seconds
export const cookieConfig = Type.Partial(
   Type.Object({
      path: Type.String({ default: "/" }),
      sameSite: StringEnum(["strict", "lax", "none"], { default: "lax" }),
      secure: Type.Boolean({ default: true }),
      httpOnly: Type.Boolean({ default: true }),
      expires: Type.Number({ default: defaultCookieExpires }), // seconds
      renew: Type.Boolean({ default: true }),
      pathSuccess: Type.String({ default: "/" }),
      pathLoggedOut: Type.String({ default: "/" }),
   }),
   { default: {}, additionalProperties: false },
);

// @todo: maybe add a config to not allow cookie/api tokens to be used interchangably?
// see auth.integration test for further details

export const jwtConfig = Type.Object(
   {
      // @todo: autogenerate a secret if not present. But it must be persisted from AppAuth
      secret: Type.String({ default: "" }),
      alg: Type.Optional(StringEnum(["HS256", "HS384", "HS512"], { default: "HS256" })),
      expires: Type.Optional(Type.Number()), // seconds
      issuer: Type.Optional(Type.String()),
      fields: Type.Array(Type.String(), { default: ["id", "email", "role"] }),
   },
   {
      default: {},
      additionalProperties: false,
   },
);
export const authenticatorConfig = Type.Object({
   jwt: jwtConfig,
   cookie: cookieConfig,
});

type AuthConfig = Static<typeof authenticatorConfig>;
export type AuthAction = "login" | "register";
export type AuthResolveOptions = {
   identifier?: "email" | string;
   redirect?: string;
   forceJsonResponse?: boolean;
};
export type AuthUserResolver = (
   action: AuthAction,
   strategy: Strategy,
   profile: ProfileExchange,
   opts?: AuthResolveOptions,
) => Promise<ProfileExchange | undefined>;
type AuthClaims = SafeUser & {
   iat: number;
   iss?: string;
   exp?: number;
};

export class Authenticator<Strategies extends Record<string, Strategy> = Record<string, Strategy>> {
   private readonly config: AuthConfig;

   constructor(
      private readonly strategies: Strategies,
      private readonly userPool: UserPool,
      config?: AuthConfig,
   ) {
      this.config = parse(authenticatorConfig, config ?? {});
   }

   async resolveLogin(
      c: Context,
      strategy: Strategy,
      profile: Partial<SafeUser>,
      verify: (user: User) => Promise<void>,
      opts?: AuthResolveOptions,
   ) {
      try {
         // @todo: centralize identifier and checks
         // @todo: check identifier value (if allowed)
         const identifier = opts?.identifier || "email";
         if (typeof identifier !== "string" || identifier.length === 0) {
            throw new InvalidConditionsException("Identifier must be a string");
         }
         if (!(identifier in profile)) {
            throw new InvalidConditionsException(`Profile must have identifier "${identifier}"`);
         }

         const user = await this.userPool.findBy(
            strategy.getName(),
            identifier as any,
            profile[identifier],
         );

         if (!user.strategy_value) {
            throw new InvalidConditionsException("User must have a strategy value");
         } else if (user.strategy !== strategy.getName()) {
            throw new InvalidConditionsException("User signed up with a different strategy");
         }

         await verify(user);
         const data = await this.safeAuthResponse(user);
         return this.respondWithUser(c, data, opts);
      } catch (e) {
         return this.respondWithError(c, e as Error, opts);
      }
   }

   async resolveRegister(
      c: Context,
      strategy: Strategy,
      profile: CreateUser,
      verify: (user: User) => Promise<void>,
      opts?: AuthResolveOptions,
   ) {
      try {
         const identifier = opts?.identifier || "email";
         if (typeof identifier !== "string" || identifier.length === 0) {
            throw new InvalidConditionsException("Identifier must be a string");
         }
         if (!(identifier in profile)) {
            throw new InvalidConditionsException(`Profile must have identifier "${identifier}"`);
         }
         if (!("strategy_value" in profile)) {
            throw new InvalidConditionsException("Profile must have a strategy value");
         }

         const user = await this.userPool.create(strategy.getName(), {
            ...profile,
            strategy_value: profile.strategy_value,
         });

         await verify(user);
         const data = await this.safeAuthResponse(user);
         return this.respondWithUser(c, data, opts);
      } catch (e) {
         return this.respondWithError(c, e as Error, opts);
      }
   }

   private async respondWithUser(c: Context, data: AuthResponse, opts?: AuthResolveOptions) {
      const successUrl = this.getSafeUrl(
         c,
         opts?.redirect ?? this.config.cookie.pathSuccess ?? "/",
      );

      if ("token" in data) {
         await this.setAuthCookie(c, data.token);

         if (this.isJsonRequest(c) || opts?.forceJsonResponse) {
            return c.json(data);
         }

         // can't navigate to "/" – doesn't work on nextjs
         return c.redirect(successUrl);
      }

      throw new Exception("Invalid response");
   }

   async respondWithError(c: Context, error: Error, opts?: AuthResolveOptions) {
      $console.error("respondWithError", error);
      if (this.isJsonRequest(c) || opts?.forceJsonResponse) {
         // let the server handle it
         throw error;
      }

      await addFlashMessage(c, String(error), "error");

      const referer = this.getSafeUrl(c, opts?.redirect ?? c.req.header("Referer") ?? "/");
      return c.redirect(referer);
   }

   getStrategies(): Strategies {
      return this.strategies;
   }

   strategy<
      StrategyName extends keyof Strategies,
      Strat extends Strategy = Strategies[StrategyName],
   >(strategy: StrategyName): Strat {
      try {
         return this.strategies[strategy] as unknown as Strat;
      } catch (e) {
         throw new Error(`Strategy "${String(strategy)}" not found`);
      }
   }

   // @todo: add jwt tests
   async jwt(_user: SafeUser | ProfileExchange): Promise<string> {
      const user = pick(_user, this.config.jwt.fields);

      const payload: JWTPayload = {
         ...user,
         iat: Math.floor(Date.now() / 1000),
      };

      // issuer
      if (this.config.jwt?.issuer) {
         payload.iss = this.config.jwt.issuer;
      }

      // expires in seconds
      if (this.config.jwt?.expires) {
         payload.exp = Math.floor(Date.now() / 1000) + this.config.jwt.expires;
      }

      const secret = this.config.jwt.secret;
      if (!secret || secret.length === 0) {
         throw new Error("Cannot sign JWT without a secret");
      }

      return sign(payload, secret, this.config.jwt?.alg ?? "HS256");
   }

   async safeAuthResponse(_user: User): Promise<AuthResponse> {
      const user = pick(_user, this.config.jwt.fields) as SafeUser;
      return {
         user,
         token: await this.jwt(user),
      };
   }

   async verify(jwt: string): Promise<AuthClaims | undefined> {
      try {
         const payload = await verify(
            jwt,
            this.config.jwt?.secret ?? "",
            this.config.jwt?.alg ?? "HS256",
         );

         // manually verify issuer (hono doesn't support it)
         if (this.config.jwt?.issuer) {
            if (payload.iss !== this.config.jwt.issuer) {
               throw new Exception("Invalid issuer", 403);
            }
         }

         return payload as any;
      } catch (e) {}

      return;
   }

   private get cookieOptions(): CookieOptions {
      const { expires = defaultCookieExpires, renew, ...cookieConfig } = this.config.cookie;

      return {
         ...cookieConfig,
         expires: new Date(Date.now() + expires * 1000),
      };
   }

   private async getAuthCookie(c: Context): Promise<string | undefined> {
      try {
         const secret = this.config.jwt.secret;
         const token = await getSignedCookie(c, secret, "auth");
         if (typeof token !== "string") {
            return undefined;
         }

         return token;
      } catch (e: any) {
         if (e instanceof Error) {
            $console.error("[getAuthCookie]", e.message);
         }

         return undefined;
      }
   }

   async requestCookieRefresh(c: Context<ServerEnv>) {
      if (this.config.cookie.renew && c.get("auth")?.user) {
         const token = await this.getAuthCookie(c);
         if (token) {
            await this.setAuthCookie(c, token);
         }
      }
   }

   private async setAuthCookie(c: Context<ServerEnv>, token: string) {
      $console.debug("setting auth cookie", truncate(token));
      const secret = this.config.jwt.secret;
      await setSignedCookie(c, "auth", token, secret, this.cookieOptions);
   }

   private deleteAuthCookie(c: Context) {
      $console.debug("deleting auth cookie");
      deleteCookie(c, "auth", this.cookieOptions);
   }

   async logout(c: Context<ServerEnv>) {
      $console.info("Logging out");
      c.set("auth", undefined);

      const cookie = await this.getAuthCookie(c);
      if (cookie) {
         addFlashMessage(c, "Signed out", "info");
      }

      // on waku, only one cookie setting is performed
      // therefore adding deleting cookie at the end
      // as the flash isn't that important
      this.deleteAuthCookie(c);
   }

   // @todo: move this to a server helper
   isJsonRequest(c: Context): boolean {
      return c.req.header("Content-Type") === "application/json";
   }

   async getBody(c: Context) {
      if (this.isJsonRequest(c)) {
         return await c.req.json();
      } else {
         return Object.fromEntries((await c.req.formData()).entries());
      }
   }

   private getSafeUrl(c: Context, path: string) {
      const p = path.replace(/\/+$/, "/");

      // nextjs doesn't support non-fq urls
      // but env could be proxied (stackblitz), so we shouldn't fq every url
      if (!runtimeSupports("redirects_non_fq")) {
         return new URL(c.req.url).origin + p;
      }

      return p;
   }

   // @todo: don't extract user from token, but from the database or cache
   async resolveAuthFromRequest(c: Context): Promise<SafeUser | undefined> {
      let token: string | undefined;
      if (c.req.raw.headers.has("Authorization")) {
         const bearerHeader = String(c.req.header("Authorization"));
         token = bearerHeader.replace("Bearer ", "");
      } else {
         token = await this.getAuthCookie(c);
      }

      if (token) {
         return await this.verify(token);
      }

      return undefined;
   }

   toJSON(secrets?: boolean) {
      return {
         ...this.config,
         jwt: secrets ? this.config.jwt : undefined,
      };
   }
}
