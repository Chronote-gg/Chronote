/** datetime-local values describe wall time in the browser's local time zone. */
export function formatLocalMeetingDate(instant?: string): string {
  if (!instant) return "";
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseLocalMeetingDate(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

export function meetingDateRangeState(search: {
  range: string;
  startDate?: string;
  endDate?: string;
}): "ready" | "incomplete" | "invalid" {
  if (search.range !== "custom") return "ready";
  if (!search.startDate || !search.endDate) return "incomplete";
  const start = Date.parse(search.startDate);
  const end = Date.parse(search.endDate);
  return Number.isFinite(start) && Number.isFinite(end) && start <= end
    ? "ready"
    : "invalid";
}
