import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DeviceIdentity } from '../../modules/device-auth/verify.js';

export interface AppRequest {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  identity?: DeviceIdentity;
}
export type AppHandler = (context: AppRequest) => Promise<void>;

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
