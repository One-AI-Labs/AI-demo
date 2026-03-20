/**
 * Vercel Serverless：直接导出 Express app（勿用 serverless-http，其默认 AWS 适配在 Vercel 上会挂起直至 504）
 * @see https://vercel.com/docs/frameworks/backend/express
 */
import app from '../server/index.js';

export default app;
