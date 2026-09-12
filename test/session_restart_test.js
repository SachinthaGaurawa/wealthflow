import { it, expect } from 'vitest';
import fs from 'node:fs';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('        function _startSessionRevokeWatcher() {');
const end=html.indexOf('        // Start watcher once Firebase auth is ready',start);
const code=html.slice(start,end);
function fixture() {
    let snapshot, local=[], signs=[];
    const firebase={firestore:()=>({collection:()=>({doc:()=>({onSnapshot:cb=>{snapshot=cb;return ()=>{};}})})})};
    new Function('firebase','currentUser','localStorage','document','setInterval','clearInterval','_getRevokedSessions','_setRevokedSessions','_performHardSignOut','_renderSessionsDebounced',
        'let _sessionRevokeChecker=null,_sessionRevokeUnsub=null;'+code+';_startSessionRevokeWatcher();')(
        firebase,{uid:'account'},{getItem:()=> 'current-session'}, {getElementById:()=>null},()=>1,()=>{},()=>local,v=>{local=v;},v=>signs.push(v),()=>{});
    return { deliver:data=>snapshot({exists:true,data:()=>data}), signs, local:()=>local };
}
it('does not sign out an unregistered session when the cached cloud list contains older sessions',()=>{
    const h=fixture();h.deliver({sessions:[{id:'other-session'}],revokedSessions:[]});
    h.deliver({sessions:[{id:'current-session'}],revokedSessions:[]});
    h.deliver({sessions:[{id:'other-session'}],revokedSessions:[]});
    expect(h.signs).toHaveLength(0);
});
it('still signs out immediately on an explicit revocation even if the active list contains the session',()=>{
    const h=fixture();h.deliver({sessions:[{id:'current-session'}],revokedSessions:['current-session']});
    expect(h.signs).toHaveLength(1);
});
it('mirrors other revocation markers without signing out the current account',()=>{
    const h=fixture();h.deliver({sessions:[],revokedSessions:['other-session']});
    expect(h.signs).toHaveLength(0);expect(h.local()).toEqual(['other-session']);
});
