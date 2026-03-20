/**
 * Vercel Serverless 入口：把 /api/* 转发给 Express（与本地 node server/index.js 同一路由）
 */
import serverless from 'serverless-http';
import app from '../server/index.js';

export default serverless(app);
