import type { Conversation, Message, Question } from './contract.js';
import type { DbDriver } from '../../db/driver.js';
/** N2a appends an entity event within its caller's database transaction. */
export async function appendEvent(
  _db: DbDriver,
  _userId: string,
  _agentId: string,
  _entity: Conversation | Message | Question,
): Promise<number> {
  throw new Error('not_implemented');
}
