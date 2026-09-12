import type { RequestHandler } from 'express';

/** Express 4 does not automatically forward rejected async handlers. */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
