import { handleApi, type Env } from "../../worker/router";

/** Cloudflare Pages Functions：/api/* 全部交给 worker 路由处理 */
export const onRequest: PagesFunction<Env> = async (ctx) => handleApi(ctx.request, ctx.env);
