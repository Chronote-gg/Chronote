import type { Request, RequestHandler, Response } from "express";
import type { Authenticator } from "passport";
import type { Profile } from "passport-discord";
import {
  stashOauthRedirectFromSession,
  readOauthRedirectFromRequest,
} from "./oauthRedirectSession";
import { readMcpAuthorizeRedirect } from "./mcpOAuthSession";
import {
  discordInstallStateStore,
  isDiscordInstallState,
  readDiscordInstallBinding,
  restoreDiscordInstallBinding,
} from "./discordInstallStateStore";

export { DISCORD_INSTALL_SESSION_KEY } from "./discordInstallStateStore";

// Both flows use the registered callback URL, but separate Passport state stores
// bind each response to its intended flow. DNT does not affect that binding.
export function discordCallbackAuthentication(
  passport: Pick<Authenticator, "authenticate">,
  frontendSiteUrl: string,
): RequestHandler {
  return (req, res, next) => {
    if (!isDiscordInstallState(req.query.state)) {
      const installBinding = readDiscordInstallBinding(req);
      stashOauthRedirectFromSession(req);
      res.locals.mcpAuthorizeRedirect = readMcpAuthorizeRedirect(req);
      passport.authenticate("discord", { failureRedirect: frontendSiteUrl })(
        req,
        res,
        (error: unknown) => {
          if (!error) restoreDiscordInstallBinding(req, installBinding);
          next(error);
        },
      );
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
    res.locals.mcpAuthorizeRedirect ||
    readOauthRedirectFromRequest(req) ||
    frontendSiteUrl
  );
}
