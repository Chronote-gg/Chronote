import type { Request, RequestHandler, Response } from "express";
import type { Authenticator } from "passport";
import type { Profile } from "passport-discord";
import {
  stashOauthRedirectFromSession,
  readOauthRedirectFromRequest,
} from "./oauthRedirectSession";
import { resolveRedirectTarget } from "./oauthRedirectService";
import {
  discordLoginStateStore,
  readDiscordLoginIntent,
  setDiscordLoginIntent,
  type DiscordLoginIntent,
} from "./discordLoginStateStore";
import { readMcpAuthorizeRedirect } from "./mcpOAuthSession";
import {
  discordInstallStateStore,
  isDiscordInstallState,
  readDiscordInstallBinding,
  restoreDiscordInstallBinding,
} from "./discordInstallStateStore";

export { DISCORD_INSTALL_SESSION_KEY } from "./discordInstallStateStore";

export function discordLoginAuthentication(
  passport: Pick<Authenticator, "authenticate">,
  frontendSiteUrl: string,
): RequestHandler {
  return (req, res, next) => {
    const returnTo =
      readMcpAuthorizeRedirect(req) ||
      resolveRedirectTarget(req.query.redirect, frontendSiteUrl, {
        allowedInternalPaths: ["/api/notion/connect"],
      }) ||
      stashOauthRedirectFromSession(req) ||
      new URL("/portal", frontendSiteUrl).toString();
    const prompt = req.query.interaction === "consent" ? "consent" : "none";
    const recoveryId =
      typeof req.query.authRecovery === "string" &&
      /^[A-Za-z0-9_-]{1,128}$/.test(req.query.authRecovery)
        ? req.query.authRecovery
        : null;
    setDiscordLoginIntent(req, { returnTo, prompt, recoveryId });
    passport.authenticate("discord", { prompt })(req, res, next);
  };
}

function loginOutcome(
  intent: DiscordLoginIntent | undefined,
  outcome: "ok" | "failed",
  siteUrl: string,
): string {
  const returnTo = intent?.returnTo ?? new URL("/portal", siteUrl).toString();
  if (returnTo.startsWith("/"))
    return outcome === "ok"
      ? returnTo
      : new URL("/portal?authOutcome=failed", siteUrl).toString();
  const target = new URL(returnTo);
  if (intent?.recoveryId)
    target.searchParams.set("authRecovery", intent.recoveryId);
  if (intent?.recoveryId || outcome === "failed")
    target.searchParams.set("authOutcome", outcome);
  return target.toString();
}

// Both flows use the registered callback URL, but separate Passport state stores
// bind each response to its intended flow. DNT does not affect that binding.
export function discordCallbackAuthentication(
  passport: Pick<Authenticator, "authenticate">,
  frontendSiteUrl: string,
): RequestHandler {
  return (req, res, next) => {
    if (!isDiscordInstallState(req.query.state)) {
      const binding = readDiscordInstallBinding(req);
      passport.authenticate(
        "discord",
        async (error: unknown, user: Express.User | false | null) => {
          let intent = readDiscordLoginIntent(req);
          if (error || !user) {
            try {
              intent ??= await discordLoginStateStore.consumeFailure(
                req,
                req.query.state,
              );
            } catch (stateError) {
              next(stateError);
              return;
            }
            res.redirect(loginOutcome(intent, "failed", frontendSiteUrl));
            return;
          }
          if (!intent) {
            res.redirect(loginOutcome(undefined, "failed", frontendSiteUrl));
            return;
          }
          const destination = loginOutcome(intent, "ok", frontendSiteUrl);
          req.logIn(user, (loginError) => {
            if (loginError) {
              next(loginError);
              return;
            }
            restoreDiscordInstallBinding(req, binding);
            req.session.save((saveError) => {
              if (saveError) {
                next(saveError);
                return;
              }
              res.locals.discordLoginRedirect = destination;
              next();
            });
          });
        },
      )(req, res, next);
      return;
    }
    passport.authenticate(
      "discord-install",
      { session: false },
      async (error: unknown, user: Profile | false | null) => {
        // Passport consumes successful state; denial can skip its state store.
        try {
          if (error || !user) {
            await discordInstallStateStore.discard(req, req.query.state);
          }
        } catch (discardError) {
          next(discardError);
          return;
        }
        if (error) {
          next(error);
          return;
        }
        if (!user) {
          res.redirect(frontendSiteUrl);
          return;
        }
        // A custom callback deliberately never logs in or replaces req.user.
        // Only the verified installer ID survives the transient OAuth profile.
        res.locals.discordInstallerId = user.id;
        next();
      },
    )(req, res, next);
  };
}

export function resolveDiscordCallbackRedirect(
  req: Request,
  res: Response,
  frontendSiteUrl: string,
): string {
  if (res.locals.discordInstallerId)
    return new URL("/join", frontendSiteUrl).toString();
  return (
    res.locals.discordLoginRedirect ||
    res.locals.mcpAuthorizeRedirect ||
    readOauthRedirectFromRequest(req) ||
    frontendSiteUrl
  );
}
