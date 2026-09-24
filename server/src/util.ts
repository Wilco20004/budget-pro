import { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 doesn't catch rejected promises from async handlers; this
 *  turns them (and thrown errors) into a JSON 400 the frontend can show. */
export function h(fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch((e: Error & { status?: number }) => {
        if (res.headersSent) return next(e);
        res.status(e.status ?? 400).json({ error: e.message });
      });
  };
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function notFound(what = 'Not found'): never {
  throw new HttpError(404, what);
}

export function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t : null;
}

export function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : fallback;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
