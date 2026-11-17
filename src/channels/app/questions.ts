import { getDb } from '../../db/connection.js';
import { getResponseHandlers } from '../../response-registry.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import type { Question } from './contract.js';
import type { QuestionRow, ConversationRow } from './db.js';
import { appTransaction, appendEvent } from './log.js';
import { accessibleConversation, requestBody, questionEntity, getConversation } from './conversations.js';
import { json, type AppHandler } from './routes.js';

export async function saveQuestion(question: Question, c: ConversationRow): Promise<void> {
  await appendEvent(getDb(), c.user_id, c.agent_group_id, question);
  await getDb().run(
    'UPDATE app_questions SET seq=?,state=?,answer_json=? WHERE id=?',
    question.seq,
    question.state,
    question.answer ? JSON.stringify(question.answer) : null,
    question.id,
  );
}
const handoffs = new Map<string, Promise<boolean>>();
async function handoff(row: QuestionRow): Promise<boolean> {
  const running = handoffs.get(row.id);
  if (running) return running;
  const promise = (async () => {
    const latest = (await getDb().get<QuestionRow>('SELECT * FROM app_questions WHERE id=?', row.id))!;
    if (latest.handoff_state !== 'pending') return latest.handoff_state === 'done';
    const c = (await getConversation(row.conversation_id))!;
    let delivered = false;
    for (const handler of getResponseHandlers()) {
      try {
        if (
          await handler({
            questionId: row.question_id,
            instance: 'app',
            messageId: row.id,
            value: JSON.parse(row.answer_json!).value,
            userId: row.answer_user_id,
            channelType: 'app',
            platformId: c.id,
            threadId: null,
          })
        ) {
          delivered = true;
          break;
        }
      } catch {
        log.warn('App question handoff failed');
      }
    }
    await appTransaction(async () => {
      if (delivered) await getDb().run("UPDATE app_questions SET handoff_state='done' WHERE id=?", row.id);
      else {
        const current = (await getDb().get<QuestionRow>('SELECT * FROM app_questions WHERE id=?', row.id))!;
        const question = questionEntity(current);
        question.state = 'open';
        question.answer = null;
        await getDb().run('UPDATE app_questions SET answer_user_id=NULL,handoff_state=NULL WHERE id=?', row.id);
        await saveQuestion(question, c);
      }
    });
    return delivered;
  })();
  handoffs.set(row.id, promise);
  try {
    return await promise;
  } finally {
    handoffs.delete(row.id);
  }
}
export async function expireQuestions(): Promise<void> {
  await appTransaction(async () => {
    const db = getDb();
    const rows = await db.all<QuestionRow>(
      `SELECT q.* FROM app_questions q WHERE state='open' AND ((expires_at IS NOT NULL AND expires_at <= ?) OR NOT EXISTS (SELECT 1 FROM pending_questions p WHERE p.question_id=q.question_id) OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id=q.session_id))`,
      Date.now(),
    );
    for (const row of rows) {
      const q = questionEntity(row);
      q.state = 'expired';
      await saveQuestion(q, (await getConversation(row.conversation_id))!);
    }
  });
}
export async function openQuestionConversationIds(): Promise<string[]> {
  return (
    await getDb().all<{ conversation_id: string }>(
      "SELECT DISTINCT conversation_id FROM app_questions WHERE state='open'",
    )
  ).map((r) => r.conversation_id);
}
export async function recoverAnswers(): Promise<void> {
  for (const row of await getDb().all<QuestionRow>("SELECT * FROM app_questions WHERE handoff_state='pending'"))
    if (!(await getDb().get('SELECT 1 FROM pending_questions WHERE question_id=?', row.question_id)))
      await getDb().run("UPDATE app_questions SET handoff_state='done' WHERE id=?", row.id);
    else await handoff(row);
  await expireQuestions();
}
export const answerQuestion: AppHandler = async (ctx) => {
  const row = await getDb().get<QuestionRow>('SELECT * FROM app_questions WHERE id=?', ctx.params.id);
  if (!row) {
    json(ctx.res, 404, { error: 'not_found', message: 'Not found.' });
    return;
  }
  const c = await accessibleConversation(ctx, row.conversation_id, true);
  if (!c) return;
  const body = await requestBody(ctx);
  if (!body) return;
  const { value } = body;
  if (typeof value !== 'string' || !questionEntity(row).options.some((o) => o.value === value)) {
    json(ctx.res, 400, { error: 'bad_request', message: 'The request is malformed.' });
    return;
  }
  await expireQuestions();
  const result = await appTransaction(async () => {
    const current = (await getDb().get<QuestionRow>('SELECT * FROM app_questions WHERE id=?', row.id))!;
    const question = questionEntity(current);
    if (question.state === 'answered' && question.answer?.value === value) return { row: current, conflict: false };
    if (question.state !== 'open') return { row: current, conflict: true };
    question.state = 'answered';
    question.answer = { value, label: question.options.find((o) => o.value === value)!.selectedLabel, at: Date.now() };
    await getDb().run(
      "UPDATE app_questions SET answer_user_id=?,handoff_state='pending' WHERE id=?",
      c.user_id,
      row.id,
    );
    await saveQuestion(question, c);
    return {
      row: (await getDb().get<QuestionRow>('SELECT * FROM app_questions WHERE id=?', row.id))!,
      conflict: false,
    };
  });
  if (result.conflict) {
    json(ctx.res, 409, {
      error: 'not_open',
      message: result.row.state === 'expired' ? 'This question has expired.' : 'This question was already answered.',
      question: questionEntity(result.row),
    });
    return;
  }
  if (result.row.handoff_state === 'pending' && !(await handoff(result.row))) {
    json(ctx.res, 502, { error: 'answer_not_delivered', message: 'The answer did not reach the agent. Try again.' });
    return;
  }
  json(ctx.res, 200, {
    question: questionEntity((await getDb().get<QuestionRow>('SELECT * FROM app_questions WHERE id=?', row.id))!),
  });
};
let timer: ReturnType<typeof setInterval> | undefined;
onHostStart(() => {
  void recoverAnswers().catch(() => log.warn('App question recovery failed'));
  timer = setInterval(() => {
    void expireQuestions().catch(() => log.warn('App question expiry failed'));
  }, 1000);
  timer.unref();
});
onHostShutdown(() => {
  clearInterval(timer);
});
