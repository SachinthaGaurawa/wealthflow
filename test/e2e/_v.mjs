import { bootApp } from './harness.mjs';
const app = await bootApp();
const r = await app.page.evaluate(()=>({
  windowDollar: typeof window.$,                      // what my detector checked
  globalScopeDollar: new Function('return typeof $')(),// what an inline handler sees
  actuallyWorks: (()=>{ try { return typeof new Function("return $('app')")() ; } catch(e){ return 'THREW: '+e.message; } })(),
}));
console.log(JSON.stringify(r,null,2));
await app.close();
