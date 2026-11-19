(function(){
 const K='__fakefs';const subs={};
 const load=()=>JSON.parse(localStorage.getItem(K)||'{}');const save=s=>localStorage.setItem(K,JSON.stringify(s));
 const col=(s,n)=>s[n]=s[n]||{};
 const snap=n=>{const s=load();return{docs:Object.keys(col(s,n)).map(id=>({id,data:()=>JSON.parse(JSON.stringify(s[n][id]))}))}};
 const emit=n=>(subs[n]||[]).forEach(cb=>cb(snap(n)));
 window.addEventListener('storage',e=>{if(e.key===K)Object.keys(subs).forEach(emit)});
 const check=o=>{JSON.stringify(o,(k,v)=>{if(v===undefined)throw new Error('undefined value at '+k);return v})};
 const db={enablePersistence:async()=>{},collection:n=>({
   get:async()=>snap(n),
   onSnapshot:(cb,err)=>{(subs[n]=subs[n]||[]).push(cb);setTimeout(()=>cb(snap(n)));return()=>{}},
   doc:id=>({get:async()=>{const d=load()[n]?.[id];return{exists:!!d,id,data:()=>d}},
     set:async(o,opt)=>{check(o);window.__writes=(window.__writes||0)+1;if(n!=='orders'&&n!=='enquiries'&&!auth.currentUser)throw new Error('PERMISSION_DENIED '+n);
       if(n==='orders'&&!auth.currentUser&&!(o.channel==='web'&&o.status==='new'))throw new Error('PERMISSION_DENIED order');
       const s=load();const c=col(s,n);c[id]=opt&&opt.merge?Object.assign({},c[id]||{},o):o;save(s);emit(n)},
     update:async(o)=>{if(!auth.currentUser)throw new Error('PERMISSION_DENIED');const s=load();const d=col(s,n)[id];if(!d)throw new Error('NOT_FOUND');for(const k in o){const v=o[k];d[k]=v&&v.__inc!=null?Math.round(((d[k]||0)+v.__inc)*100)/100:v}save(s);emit(n)},
     delete:async()=>{const s=load();delete col(s,n)[id];save(s);emit(n)}})})};
 const auth={currentUser:JSON.parse(sessionStorage.getItem('__fu')||'null'),onAuthStateChanged(cb){setTimeout(()=>cb(this.currentUser));return()=>{}},
   async signInWithEmailAndPassword(e,p){if(p!=='secret123')throw new Error('auth/wrong-password');this.currentUser={email:e};sessionStorage.setItem('__fu',JSON.stringify(this.currentUser))},
   async signOut(){this.currentUser=null;sessionStorage.removeItem('__fu')}};
 const fs=()=>db;fs.FieldValue={increment:d=>({__inc:d})};
 window.firebase={initializeApp:c=>{if(!c||!c.apiKey)throw new Error('bad config')},firestore:fs,auth:()=>auth};
})();
