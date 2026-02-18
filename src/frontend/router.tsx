import {
  lazyRouteComponent,
  Navigate,
  Outlet,
  RootRoute,
  Route,
  Router,
} from "@tanstack/react-router";
import { z } from "zod";
import MarketingLayout from "./layouts/MarketingLayout";

const PortalLayout = lazyRouteComponent(() => import("./layouts/PortalLayout"));
const SuperAdminLayout = lazyRouteComponent(
  () => import("./layouts/SuperAdminLayout"),
);
const PortalServerLayout = lazyRouteComponent(
  () => import("./layouts/PortalServerLayout"),
);
const ServerSelect = lazyRouteComponent(() => import("./pages/ServerSelect"));
const Home = lazyRouteComponent(() => import("./pages/Home"));
const Join = lazyRouteComponent(() => import("./pages/Join"));
const PromoLanding = lazyRouteComponent(() => import("./pages/PromoLanding"));
const Upgrade = lazyRouteComponent(() => import("./pages/Upgrade"));
const UpgradeServerSelect = lazyRouteComponent(
  () => import("./pages/UpgradeServerSelect"),
);
const UpgradeSuccess = lazyRouteComponent(
  () => import("./pages/UpgradeSuccess"),
);
const Library = lazyRouteComponent(() => import("./pages/Library"));
const Ask = lazyRouteComponent(() => import("./pages/Ask"));
const PublicAsk = lazyRouteComponent(() => import("./pages/PublicAsk"));
const PublicMeeting = lazyRouteComponent(() => import("./pages/PublicMeeting"));
const Billing = lazyRouteComponent(() => import("./pages/Billing"));
const Settings = lazyRouteComponent(() => import("./pages/Settings"));
const LiveMeeting = lazyRouteComponent(() => import("./pages/LiveMeeting"));
const AdminHome = lazyRouteComponent(() => import("./pages/AdminHome"));
const AdminConfig = lazyRouteComponent(() => import("./pages/AdminConfig"));
const AdminFeedback = lazyRouteComponent(() => import("./pages/AdminFeedback"));
import { useGuildContext } from "./contexts/GuildContext";
import { usePortalStore } from "./stores/portalStore";

function RootLayout() {
  return <Outlet />;
}

const rootRoute = new RootRoute({
  component: RootLayout,
});

const marketingRoute = new Route({
  getParentRoute: () => rootRoute,
  id: "marketing",
  component: MarketingLayout,
});

const optionalStringParam = z
  .preprocess((value) => {
    if (value === undefined || value === null) return undefined;
    return String(value);
  }, z.string())
  .optional();

const booleanParamValues = new Map<string, boolean>([
  ["true", true],
  ["1", true],
  ["false", false],
  ["0", false],
]);

const optionalBooleanParam = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === false) return value;
  const parsed = booleanParamValues.get(String(value).toLowerCase());
  return parsed;
}, z.boolean().optional());

const portalMeetingSearchSchema = z.object({
  meetingId: optionalStringParam,
  eventId: optionalStringParam,
  fullScreen: optionalBooleanParam,
}).parse;

const homeRoute = new Route({
  getParentRoute: () => marketingRoute,
  path: "/",
  component: Home,
});

const joinRoute = new Route({
  getParentRoute: () => marketingRoute,
  path: "join",
  component: Join,
});

const promoRoute = new Route({
  getParentRoute: () => marketingRoute,
  path: "promo/$code",
  component: PromoLanding,
});

const upgradeRoute = new Route({
  getParentRoute: () => marketingRoute,
  path: "upgrade",
  component: Upgrade,
  validateSearch: z.object({
    promo: z.string().optional(),
    serverId: optionalStringParam,
    plan: z.enum(["basic", "pro"]).optional(),
    interval: z.enum(["month", "year"]).optional(),
    canceled: z
      .preprocess((value) => {
        if (value === "true") return true;
        if (value === "false") return false;
        return value;
      }, z.boolean().optional())
      .optional(),
  }).parse,
});

const upgradeSelectRoute = new Route({
  getParentRoute: () => marketingRoute,
  path: "upgrade/select-server",
  component: UpgradeServerSelect,
  validateSearch: z.object({
    promo: z.string().optional(),
    serverId: optionalStringParam,
    plan: z.enum(["basic", "pro"]).optional(),
    interval: z.enum(["month", "year"]).optional(),
    canceled: z
      .preprocess((value) => {
        if (value === "true") return true;
        if (value === "false") return false;
        return value;
      }, z.boolean().optional())
      .optional(),
  }).parse,
});

const upgradeSuccessRoute = new Route({
  getParentRoute: () => marketingRoute,
  path: "upgrade/success",
  component: UpgradeSuccess,
  validateSearch: z.object({
    promo: z.string().optional(),
    serverId: optionalStringParam,
    plan: z.enum(["basic", "pro"]).optional(),
    interval: z.enum(["month", "year"]).optional(),
    session_id: z.string().optional(),
  }).parse,
});

const liveMeetingRoute = new Route({
  getParentRoute: () => rootRoute,
  path: "live/$guildId/$meetingId",
  component: LiveMeeting,
});

const adminRoute = new Route({
  getParentRoute: () => rootRoute,
  path: "admin",
  component: SuperAdminLayout,
});

const portalRoute = new Route({
  getParentRoute: () => rootRoute,
  path: "portal",
  component: PortalLayout,
});

function PortalIndexRedirect() {
  const { selectedGuildId, guilds } = useGuildContext();
  const lastServerId = usePortalStore((state) => state.lastServerId);
  const targetServerId = selectedGuildId || lastServerId;
  if (targetServerId) {
    const canManage =
      guilds.find((guild) => guild.id === targetServerId)?.canManage ?? false;
    return (
      <Navigate
        to={
          canManage
            ? "/portal/server/$serverId/library"
            : "/portal/server/$serverId/ask"
        }
        params={{ serverId: targetServerId }}
      />
    );
  }
  return <Navigate to="/portal/select-server" />;
}

const portalIndexRoute = new Route({
  getParentRoute: () => portalRoute,
  path: "/",
  component: PortalIndexRedirect,
});

const portalSelectRoute = new Route({
  getParentRoute: () => portalRoute,
  path: "select-server",
  component: ServerSelect,
  validateSearch: z.object({ promo: z.string().optional() }).parse,
});

const portalServerRoute = new Route({
  getParentRoute: () => portalRoute,
  path: "server/$serverId",
  component: PortalServerLayout,
  validateSearch: portalMeetingSearchSchema,
});

const portalLibraryRoute = new Route({
  getParentRoute: () => portalServerRoute,
  path: "library",
  component: Library,
  validateSearch: z.object({
    meetingId: optionalStringParam,
    eventId: optionalStringParam,
    fullScreen: optionalBooleanParam,
  }).parse,
});

const askSearchSchema = z.object({
  list: z.enum(["mine", "shared", "archived"]).optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  meetingId: optionalStringParam,
  eventId: optionalStringParam,
  fullScreen: optionalBooleanParam,
}).parse;

const portalAskRoute = new Route({
  getParentRoute: () => portalServerRoute,
  path: "ask",
  component: Ask,
  validateSearch: askSearchSchema,
});

const publicAskSearchSchema = z.object({
  messageId: z.string().optional(),
}).parse;

const publicAskRoute = new Route({
  getParentRoute: () => rootRoute,
  path: "share/ask/$serverId/$conversationId",
  component: PublicAsk,
  validateSearch: publicAskSearchSchema,
});

const publicMeetingRoute = new Route({
  getParentRoute: () => rootRoute,
  path: "share/meeting/$serverId/$shareId",
  component: PublicMeeting,
});

const portalBillingRoute = new Route({
  getParentRoute: () => portalServerRoute,
  path: "billing",
  component: Billing,
  validateSearch: z.object({ promo: z.string().optional() }).parse,
});

const portalSettingsRoute = new Route({
  getParentRoute: () => portalServerRoute,
  path: "settings",
  component: Settings,
});

function PortalAdminConfigRedirect() {
  return <Navigate to="/admin/config" />;
}

function PortalAdminFeedbackRedirect() {
  return <Navigate to="/admin/feedback" />;
}

const portalAdminConfigRoute = new Route({
  getParentRoute: () => portalRoute,
  path: "admin/config",
  component: PortalAdminConfigRedirect,
});

const portalAdminFeedbackRoute = new Route({
  getParentRoute: () => portalRoute,
  path: "admin/feedback",
  component: PortalAdminFeedbackRedirect,
});

const adminIndexRoute = new Route({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminHome,
});

const adminConfigRoute = new Route({
  getParentRoute: () => adminRoute,
  path: "config",
  component: AdminConfig,
});

const adminFeedbackRoute = new Route({
  getParentRoute: () => adminRoute,
  path: "feedback",
  component: AdminFeedback,
});

const routeTree = rootRoute.addChildren([
  marketingRoute.addChildren([
    homeRoute,
    joinRoute,
    promoRoute,
    upgradeRoute,
    upgradeSelectRoute,
    upgradeSuccessRoute,
  ]),
  liveMeetingRoute,
  adminRoute.addChildren([
    adminIndexRoute,
    adminConfigRoute,
    adminFeedbackRoute,
  ]),
  publicAskRoute,
  publicMeetingRoute,
  portalRoute.addChildren([
    portalIndexRoute,
    portalSelectRoute,
    portalServerRoute.addChildren([
      portalLibraryRoute,
      portalAskRoute,
      portalBillingRoute,
      portalSettingsRoute,
    ]),
    portalAdminConfigRoute,
    portalAdminFeedbackRoute,
  ]),
]);

export const router = new Router({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
