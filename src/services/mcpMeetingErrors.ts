export class McpMeetingAccessError extends Error {
  constructor(
    message: string,
    readonly code:
      | "forbidden"
      | "not_found"
      | "rate_limited"
      | "bad_request"
      | "artifact_unavailable",
  ) {
    super(message);
  }
}
