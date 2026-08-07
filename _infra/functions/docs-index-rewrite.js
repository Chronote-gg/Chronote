// Maps directory-style docs URLs onto the objects that actually exist in S3.
//
// The docs origin is an S3 bucket behind OAC, not an S3 website endpoint, so it
// has no directory-index behaviour: a request for /integrations/remote-mcp/
// finds no such key, S3 answers 403, and the distribution's custom error
// response serves /404.html. Docusaurus then routes client-side, so a person
// sees the right page while the response carries a 404 status. That is
// invisible in a browser and fatal to crawlers, which believe the status.
//
// Rewriting the URI here means the correct object is fetched and a 200 is
// returned. Genuine misses still fall through to the 404 response, because the
// rewritten key does not exist either.

// CloudFront invokes a global named `handler`; there is no module system and
// nothing imports this, so it reads as unused to eslint.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.charAt(uri.length - 1) === "/") {
    request.uri = uri + "index.html";
    return request;
  }

  // Only the last segment decides whether this looks like a file, so a path
  // such as /v1.2/guide is treated as a directory rather than an asset.
  var lastSegment = uri.substring(uri.lastIndexOf("/") + 1);
  if (lastSegment.indexOf(".") === -1) {
    request.uri = uri + "/index.html";
  }

  return request;
}
