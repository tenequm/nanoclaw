import { notImplemented, type AppHandler } from '../../channels/app/routes.js';
/** N1 implements pairing and revocation. */
export const handlePair: AppHandler = (context) => notImplemented(context, 'N1');
/** N1 implements device revocation. */
export const handleRevoke: AppHandler = (context) => notImplemented(context, 'N1');
