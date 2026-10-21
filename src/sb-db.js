// sb-db.js: the small document-style API the app was written against (collection/doc, onSnapshot, get/set/update/delete),
// implemented on Supabase tables (see supabase/schema.sql). Security lives in the database's RLS, not here.
// Photos go to the private Storage bucket "photos" at <uid>/<postId>_<n>[_<ver>].jpg; post docs keep "sb:<path>" and the app sees signed URLs.
function makeSbDb(sb, me){
  const BUCKET="photos",SIGN_S=24*3600,urls=new Map(),back=new Map();
  const isData=u=>typeof u==="string"&&u.startsWith("data:image/");
  async function sign(paths){const now=Date.now();const need=[...new Set(paths)].filter(p=>{const c=urls.get(p);return !c||c.exp<now+3600e3});
    for(let i=0;i<need.length;i+=100){const chunk=need.slice(i,i+100);const {data,error}=await sb.storage.from(BUCKET).createSignedUrls(chunk,SIGN_S);
      if(!error&&data)data.forEach((d,j)=>{if(d&&d.signedUrl){urls.set(chunk[j],{url:d.signedUrl,exp:now+SIGN_S*1000});back.set(d.signedUrl,chunk[j])}})}}
  const urlOf=v=>typeof v==="string"&&v.startsWith("sb:")?(urls.get(v.slice(3))?.url||null):v;
  async function upload(path,dataUrl){const blob=await (await fetch(dataUrl)).blob();
    const {error}=await sb.storage.from(BUCKET).upload(path,blob,{upsert:true,contentType:blob.type||"image/jpeg",cacheControl:"31536000"});if(error)throw error;urls.delete(path)}
  const fail=e=>{const err=new Error(e?.message||"db error");err.code=/quota|exceed|limit/i.test(e?.message||"")?"quota_exceeded":(e?.code||"db_error");return err};
  const chk=({data,error})=>{if(error)throw fail(error);return data};

  // ---- path routing ----
  function route(path){const s=String(path).split("/");
    if(s[0]==="profiles")return{t:"profiles",id:s[1]};
    if(s[0]==="follows")return{t:"follows",id:s[1]};
    if(s[0]==="posts"&&s[2]==="items")return{t:"posts",owner:s[1],id:s[3]};
    if(s[0]==="posts"&&s[2]==="pics")return{t:"pics",owner:s[1],id:s[3]};
    if(s[0]==="reacts"&&s[2]==="items")return{t:"reacts",owner:s[1],id:s[3]};
    if(s[0]==="data"&&s[1]==="users")return{t:"user_data",owner:s[2],id:s[3]};
    if(s[0]==="names")return{t:"names",id:s[1]};
    throw new Error("unknown path "+path)}
  const OWNER={posts:"author",reacts:"author",user_data:"owner"};
  // profiles: who you may read depends on follow edges (is_connected), so an edge change refetches them too
  const TABLES={profiles:["profiles","follow_edges"],follows:["follow_edges","follow_meta"],posts:["posts"],reacts:["reacts"],user_data:["user_data"]};
  function keyed(q,r){if(r.t==="profiles")return q.eq("id",r.id);if(r.t==="names")return q.eq("key",r.id);return q.eq(OWNER[r.t],r.owner).eq("id",r.id)}
  const snap=docs=>({docs:docs.map(([id,d])=>({id,data:()=>d})),metadata:{fromCache:false},size:docs.length,empty:!docs.length});
  const docSnap=d=>({exists:d!=null,data:()=>d,id:null});

  async function postOut(rows){await sign(rows.map(r=>r.data&&r.data.photo).filter(v=>typeof v==="string"&&v.startsWith("sb:")).map(v=>v.slice(3)));
    return rows.map(r=>[r.id,{...r.data,photo:urlOf(r.data.photo)}])}

  // ---- follows: rebuilt from edges that touch me + my private meta ----
  async function readFollows(){
    const [edges,meta]=await Promise.all([sb.from("follow_edges").select("src,dst,since").then(chk),sb.from("follow_meta").select("data").eq("owner",me).maybeSingle().then(chk)]);
    const out={},mine={ids:[],since:{},...((meta&&meta.data)||{})};
    for(const e of edges){if(e.src===me){mine.ids.push(e.dst);mine.since[e.dst]=+e.since||0}
      else if(e.dst===me)out[e.src]={ids:[me],since:{[me]:+e.since||0}}}
    out[me]=mine;return out}
  async function writeFollows(data){
    const cur=(await readFollows())[me];const want=new Set(data.ids||[]),have=new Set(cur.ids||[]);
    for(const id of have)if(!want.has(id))chk(await sb.from("follow_edges").delete().eq("src",me).eq("dst",id));
    for(const id of want)if(!have.has(id))chk(await sb.from("follow_edges").insert({src:me,dst:id,since:(data.since||{})[id]||Date.now()}));
    const {ids,since,...rest}=data;chk(await sb.from("follow_meta").upsert({owner:me,data:rest},{onConflict:"owner"}))}

  // ---- reads ----
  async function readColl(r,opt){
    if(r.t==="profiles")return snap(chk(await sb.from("profiles").select("id,data")).map(x=>[x.id,x.data]));
    if(r.t==="follows")return snap(Object.entries(await readFollows()));
    if(r.t==="posts"){let q=sb.from("posts").select("id,data").eq("author",r.owner).order("created_at",{ascending:false});if(opt.limit)q=q.limit(opt.limit);return snap(await postOut(chk(await q)))}
    if(r.t==="reacts"){let q=sb.from("reacts").select("id,data").eq("author",r.owner).order("at",{ascending:false});if(opt.limit)q=q.limit(opt.limit);return snap(chk(await q).map(x=>[x.id,x.data]))}
    if(r.t==="user_data")return snap(chk(await sb.from("user_data").select("id,data").eq("owner",r.owner)).map(x=>[x.id,x.data]));
    throw new Error("no collection "+r.t)}
  async function readDoc(r){
    if(r.t==="follows")return docSnap((await readFollows())[r.id]||null);
    if(r.t==="pics"){const {data,error}=await sb.storage.from(BUCKET).createSignedUrl(`${r.owner}/${r.id}.jpg`,SIGN_S);return docSnap(error||!data?null:{d:data.signedUrl})}
    if(r.t==="names"){const x=chk(await sb.from("names").select("owner,at").eq("key",r.id).maybeSingle());return docSnap(x?{owner:x.owner,at:+x.at}:null)}
    const cols=r.t==="profiles"?"data":"id,data";const x=chk(await keyed(sb.from(r.t).select(cols),r).maybeSingle());
    if(!x)return docSnap(null);if(r.t==="posts")return docSnap((await postOut([x]))[0][1]);return docSnap(x.data)}

  // ---- writes ----
  async function writeDoc(r,data){
    if(r.t==="follows"){if(r.id!==me)throw fail({message:"not yours"});return writeFollows(data)}
    if(r.t==="pics"){if(isData(data.d))return upload(`${me}/${r.id}.jpg`,data.d);return}
    if(r.t==="names")return chk(await sb.from("names").upsert({key:r.id,owner:data.owner,at:data.at||Date.now()},{onConflict:"key"}));
    if(r.t==="profiles")return chk(await sb.from("profiles").upsert({id:r.id,data,updated_at:new Date().toISOString()},{onConflict:"id"}));
    if(r.t==="posts"){const d={...data};
      if(isData(d.photo)){const old=chk(await sb.from("posts").select("data").eq("author",me).eq("id",r.id).maybeSingle());
        const path=`${me}/${r.id}_0_${Date.now().toString(36)}.jpg`;await upload(path,d.photo);d.photo="sb:"+path;
        const op=old&&old.data&&old.data.photo;if(typeof op==="string"&&op.startsWith("sb:")&&op.slice(3)!==path)await sb.storage.from(BUCKET).remove([op.slice(3)])}
      else if(typeof d.photo==="string"&&back.has(d.photo))d.photo="sb:"+back.get(d.photo);
      const res=chk(await sb.from("posts").upsert({author:me,id:r.id,created_at:+d.createdAt||Date.now(),data:d},{onConflict:"author,id"}));ring();return res}
    if(r.t==="reacts")return chk(await sb.from("reacts").upsert({author:me,id:r.id,at:+data.at||Date.now(),data},{onConflict:"author,id"}));
    if(r.t==="user_data")return chk(await sb.from("user_data").upsert({owner:me,id:r.id,data},{onConflict:"owner,id"}));
    throw new Error("no write "+r.t)}
  async function deleteDoc(r){
    if(r.t==="pics"){const {error}=await sb.storage.from(BUCKET).remove([`${me}/${r.id}.jpg`]);if(error)throw fail(error);return}
    if(r.t==="posts"){const old=chk(await sb.from("posts").select("data").eq("author",me).eq("id",r.id).maybeSingle());const op=old&&old.data&&old.data.photo;
      chk(await sb.from("posts").delete().eq("author",me).eq("id",r.id));
      if(typeof op==="string"&&op.startsWith("sb:"))await sb.storage.from(BUCKET).remove([op.slice(3)]);ring();return}
    if(r.t==="follows")return writeFollows({ids:[]});
    return chk(await keyed(sb.from(r.t).delete(),r))}

  // ---- live updates: any change on the table refetches this listener (debounced), plus a slow poll as a safety net ----
  const live=new Set();let chan=null,timer=null;
  function ring(){try{if(chan)chan.send({type:"broadcast",event:"posts",payload:{}})}catch(e){}}
  function kick(tables){for(const l of live)if(!tables||l.tables.some(t=>tables.includes(t)))l.refresh()}
  function ensureChannel(){if(chan)return;chan=sb.channel("hp-live");
    // HP_RT counts what arrives, so a test (or the console) can tell whether live updates work
    const rt=window.HP_RT={status:null,events:{},log:[]};const seen=t=>{rt.events[t]=(rt.events[t]||0)+1;if(rt.log.length<60)rt.log.push([Date.now(),t])};
    for(const t of ["profiles","follow_edges","follow_meta","posts","reacts","user_data"])chan.on("postgres_changes",{event:"*",schema:"public",table:t},()=>{seen(t);kick([t])});
    // a new post also rings an empty broadcast so friends refetch at once (no content is sent; what they can read is still decided by RLS)
    chan.on("broadcast",{event:"posts"},()=>{seen("broadcast");kick(["posts"])});
    chan.subscribe((st,err)=>{rt.status=st+(err?" "+(err.message||err):"");seen("status:"+rt.status)});timer=setInterval(()=>{if(document.visibilityState==="visible")kick()},90000);
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")kick()})}
  function listen(r,opt,cb,err){const l={tables:TABLES[r.t]||[],busy:false,again:false,t:0,dead:false};
    const run=async()=>{if(l.dead)return;if(l.busy){l.again=true;return}l.busy=true;const rt=window.HP_RT;try{const s=await readColl(r,opt);if(rt&&rt.log.length<60)rt.log.push([Date.now(),"read:"+r.t+":"+s.docs.length]);if(!l.dead)cb(s)}catch(e){if(rt&&rt.log.length<60)rt.log.push([Date.now(),"err:"+r.t+":"+(e&&e.message)]);err&&err(e)}l.busy=false;if(l.again){l.again=false;run()}};
    l.refresh=()=>{clearTimeout(l.t);l.t=setTimeout(run,250)};l.r=r;live.add(l);ensureChannel();run();
    return()=>{l.dead=true;clearTimeout(l.t);live.delete(l)}}

  function query(path,opt){const r=route(path);return{
    orderBy(){return query(path,opt)},limit(n){return query(path,{...opt,limit:n})},
    onSnapshot(cb,err){return listen(r,opt,cb,err)},get(){return readColl(r,opt)}}}
  return{
    collection:path=>query(path,{}),
    doc(path){const r=route(path);return{
      get:()=>readDoc(r),
      set:async d=>{await writeDoc(r,d);kick(TABLES[r.t])},
      update:async patch=>{const cur=await readDoc(r);if(!cur.exists)throw fail({message:"not found"});await writeDoc(r,{...cur.data(),...patch});kick(TABLES[r.t])},
      delete:async()=>{await deleteDoc(r);kick(TABLES[r.t])},
      acquire:async()=>({acquired:true,release(){}})}}}
}
