/** wrangler.toml 的 Text 规则让 .sql 以字符串导入（这里只做类型声明） */
declare module "*.sql" {
    const content: string;
    export default content;
}
