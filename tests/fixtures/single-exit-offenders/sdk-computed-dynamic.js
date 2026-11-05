// expect: computed-dynamic-import
const name = '@tencent-connect/' + 'qqbot-nodejs';
export const load = () => import(name);
