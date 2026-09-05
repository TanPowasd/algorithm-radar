/// <reference path="../../pages-env.d.ts" />

/**
 * Pages 只做同源 API 转发，不复制业务逻辑、不直接绑定数据库。
 * 原样传递 URL、Cookie、CSRF、请求体和响应流（含 Set-Cookie / ETag / 导出头）。
 */
export const onRequest: PagesFunction<PagesEnv> = (context) => {
    return context.env.API.fetch(context.request);
};
