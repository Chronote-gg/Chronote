// Serves the SPA only for routes the frontend actually owns.
//
// The old CloudFront fallback converted every missing S3 object into index.html
// with a 200 response. That made direct SPA navigation work, but it also made
// every typo and nonexistent crawler URL look like a valid copy of the home
// page. Keep the known app routes, preserve the extensionless public-route
// objects that carry route-specific metadata, and return a real 404 for other
// extensionless paths.

// Keep this list aligned with scripts/public-routes.json. The function test
// reads that registry and fails if a public route is missing here.
var publicRoutes = ["/join", "/upgrade", "/feedback"];

function isPublicRoute(uri) {
  for (var i = 0; i < publicRoutes.length; i += 1) {
    if (uri === publicRoutes[i]) return true;
  }
  return false;
}

function publicRouteWithoutTrailingSlash(uri) {
  for (var i = 0; i < publicRoutes.length; i += 1) {
    if (uri === publicRoutes[i] + "/") return publicRoutes[i];
  }
  return null;
}

function isSpaRoute(uri) {
  return (
    uri === "/admin" ||
    uri.indexOf("/admin/") === 0 ||
    uri === "/portal" ||
    uri.indexOf("/portal/") === 0 ||
    uri === "/upgrade/select-server" ||
    uri === "/upgrade/success" ||
    /^\/promo\/[^/]+$/.test(uri) ||
    /^\/live\/[^/]+\/[^/]+$/.test(uri) ||
    /^\/share\/ask\/[^/]+\/[^/]+$/.test(uri) ||
    /^\/share\/meeting\/[^/]+\/[^/]+$/.test(uri)
  );
}

// CloudFront invokes a global named `handler`; there is no module system and
// nothing imports this, so it reads as unused to eslint.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri === "/") {
    request.uri = "/index.html";
    return request;
  }

  if (isPublicRoute(uri)) return request;

  var canonicalPublicRoute = publicRouteWithoutTrailingSlash(uri);
  if (canonicalPublicRoute) {
    // Rewrite rather than redirect so campaign query parameters remain intact.
    // The served document carries the no-slash canonical URL.
    request.uri = canonicalPublicRoute;
    return request;
  }

  if (isSpaRoute(uri)) {
    request.uri = "/index.html";
    return request;
  }

  // Let real files reach S3. Missing files receive the distribution's real
  // 404 response, while deployed assets and crawler files continue to work.
  var lastSegment = uri.substring(uri.lastIndexOf("/") + 1);
  if (lastSegment.indexOf(".") !== -1) return request;

  return {
    statusCode: 404,
    statusDescription: "Not Found",
    headers: {
      "cache-control": { value: "public, max-age=60" },
      "content-type": { value: "text/plain; charset=utf-8" },
      "x-robots-tag": { value: "noindex, nofollow" },
    },
    body: "Not Found",
  };
}
