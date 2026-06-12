import {
  Registry,
  collectDefaultMetrics,
  Histogram,
  Counter,
} from "prom-client";
import type { NextFunction, Request, Response } from "express";

// Single global registry for the process
export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

// HTTP request duration histogram
const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [metricsRegistry],
});

// Basic app-level counters we can increment from other modules
export const meetingsStarted = new Counter({
  name: "meeting_started_total",
  help: "Total meetings started",
  registers: [metricsRegistry],
});

export const meetingsCancelled = new Counter({
  name: "meeting_cancelled_total",
  help: "Total meetings cancelled due to low content",
  registers: [metricsRegistry],
});

export const liveVoiceResponses = new Counter({
  name: "live_voice_responses_total",
  help: "Total live voice responses spoken",
  registers: [metricsRegistry],
});

export const chatTtsEnqueued = new Counter({
  name: "chat_tts_enqueued_total",
  help: "Total chat-to-speech messages enqueued",
  registers: [metricsRegistry],
});

export const chatTtsSpoken = new Counter({
  name: "chat_tts_spoken_total",
  help: "Total chat-to-speech messages spoken",
  registers: [metricsRegistry],
});

export const chatTtsDropped = new Counter({
  name: "chat_tts_dropped_total",
  help: "Total chat-to-speech messages dropped",
  registers: [metricsRegistry],
});

export const chatTtsMonthlyLimitBlocked = new Counter({
  name: "chat_tts_monthly_limit_blocked_total",
  help: "Total chat-to-speech messages blocked by monthly usage limits",
  registers: [metricsRegistry],
});

// Express middleware to time requests
export function metricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    const route =
      (req.route && "path" in req.route
        ? (req.route as { path?: string }).path
        : undefined) ||
      req.path ||
      "unknown";
    end({ method: req.method, route, status: res.statusCode });
  });
  next();
}
