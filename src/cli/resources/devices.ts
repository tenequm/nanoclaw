import type { DeviceRow } from '../../modules/device-auth/db.js';
/** N1 registers guarded ncl devices list, pair and revoke commands. */
export async function listDevices(_userId: string): Promise<DeviceRow[]> {
  throw new Error('not_implemented');
}
/** N1 creates an expiring pairing link for the specified agent subset. */
export async function pairDevice(_userId: string, _agentIds: string[]): Promise<string> {
  throw new Error('not_implemented');
}
/** N1 revokes a device and closes its live streams. */
export async function revokeDevice(_deviceId: string): Promise<void> {
  throw new Error('not_implemented');
}
