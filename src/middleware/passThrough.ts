import type { RequestHandler } from "express";

export const passThrough: RequestHandler = (_req, _res, next) => {
  next();
};
