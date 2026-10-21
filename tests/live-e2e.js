// Live test against the real site + real Supabase: 3 throwaway accounts check mutual-only visibility,
// photo posts, likes/comments and account deletion, then delete themselves. Run from GitHub Actions (live-test.yml).
const {chromium}=require("playwright");
const BASE=process.env.BASE||"https://ruikougyo.github.io/harapangram/";
const R=Math.random().toString(36).slice(2,8);const PW="Pw-"+R+"-test1";const PH="てすと "+R;
const out={};const fails=[];const ok=(k,v)=>{out[k]=v;if(!v)fails.push(k)};const W=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  // wait until GitHub Pages serves this commit
  for(let i=0;i<40;i++){const t=await fetch(BASE+"?v="+Date.now()).then(r=>r.text()).catch(()=>"");if(t.includes(process.env.MARKER||"osmBtn"))break;await W(15000)}
  const b=await chromium.launch();const users=[];
  async function signup(nick,id){const ctx=await b.newContext({viewport:{width:390,height:844}});const p=await ctx.newPage();const errs=[];
    p.on("pageerror",e=>errs.push(e.message));p.on("console",m=>{if(m.type()==="error"&&!/Failed to load resource/.test(m.text()))errs.push(m.text())});
    await p.goto(BASE);await p.waitForSelector("#auth:not([hidden])",{timeout:30000});await p.click("text=はじめての人はこちら");
    await p.fill("#auth input[autocomplete=nickname]",nick);await p.fill("#auth input[autocomplete=username]",id);
    await p.fill("#auth input[type=password] >> nth=0",PW);await p.fill("#auth input[type=password] >> nth=1",PW);
    await p.fill("#auth input[placeholder^='例：はじめて']",PH);await p.check("#auth .agree input");await p.click("#auth button[type=submit]");
    await p.waitForFunction(()=>typeof S!=="undefined"&&S.me&&S.ready,null,{timeout:30000});await W(1500);
    const me=await p.evaluate(()=>S.me);const u={p,ctx,errs,id,me,nick};users.push(u);return u}
  const jpeg=async(p,hue)=>Buffer.from(await p.evaluate(h=>{const c=document.createElement("canvas");c.width=1200;c.height=900;const x=c.getContext("2d");
    x.fillStyle=`hsl(${h},60%,60%)`;x.fillRect(0,0,1200,900);x.fillStyle="#fff";x.font="bold 160px sans-serif";x.fillText("TEST",380,500);return c.toDataURL("image/jpeg",.9).split(",")[1]},hue),"base64");
  try{
    const A=await signup("テストA","zz_a_"+R),B=await signup("テストB","zz_b_"+R),C=await signup("テストC","zz_c_"+R);
    // strangers are invisible until found by exact ID
    ok("strangerHidden",await A.p.evaluate(async()=>(await S.sb.from("profiles").select("id")).data.length===1));
    await A.p.evaluate(()=>go("friends"));await A.p.fill("#fSearch",B.id.slice(0,6));await W(1500);
    ok("partialSearchEmpty",(await A.p.locator("#friendList .item").count())===0);
    await A.p.fill("#fSearch",B.id);await W(2500);ok("exactSearchFinds",(await A.p.locator("#friendList .item",{hasText:"テストB"}).count())===1);
    // A <-> B mutual, C -> A one-way
    await A.p.evaluate(id=>toggleFollow(id),B.me);await W(1500);await B.p.evaluate(id=>toggleFollow(id),A.me);await C.p.evaluate(id=>toggleFollow(id),A.me);await W(3000);
    ok("mutual",await A.p.evaluate(id=>mutualIds().includes(id),B.me));
    // A posts 2 photos through the form
    const p=A.p;await p.evaluate(()=>go("post"));await W(500);
    await p.setInputFiles("#pPhoto",[{name:"a.jpg",mimeType:"image/jpeg",buffer:await jpeg(p,20)},{name:"b.jpg",mimeType:"image/jpeg",buffer:await jpeg(p,200)}]);await W(2500);
    await p.fill("#pName","テスト食堂"+R);await p.selectOption("#pPref","13");await p.fill("#pHours","11:00〜15:00");await p.click("#pSubmit");await W(6000);
    const post=await p.evaluate(async()=>{const s=await S.sb.from("posts").select("id,data").eq("author",S.me);return s.data[0]});
    ok("posted",!!post&&post.data.pics===1&&/^sb:/.test(post.data.photo));
    // B sees it with photos
    await B.p.evaluate(()=>go("feed"));await W(6000);const art=B.p.locator("article",{hasText:"テスト食堂"+R}).first();
    ok("bSeesPost",(await art.count())===1);
    if(await art.count()){await art.scrollIntoViewIfNeeded();await W(3000);const im=await art.locator("img").evaluateAll(a=>a.map(i=>i.naturalWidth));ok("bSeesPhotos",im.filter(w=>w>0).length>=2);out.bImgs=im}
    // C (one-way) sees nothing, even asking the database and storage directly
    ok("cNoRows",await C.p.evaluate(async a=>(await S.sb.from("posts").select("id").eq("author",a)).data.length===0,A.me));
    ok("cNoPhoto",await C.p.evaluate(async path=>{const r=await S.sb.storage.from("photos").createSignedUrl(path,60);return !r.data||!r.data.signedUrl},post&&post.data.photo.slice(3)));
    ok("cNoWrite",await C.p.evaluate(async a=>!!(await S.sb.from("posts").upsert({author:a,id:"hack",data:{name:"x"}},{onConflict:"author,id"})).error,A.me));
    // B likes + comments, A is notified
    await B.p.evaluate(async n=>{const q=visiblePosts().find(x=>x.name===n);await S.db.doc(`reacts/${S.me}/items/l_${pkey(q)}`).set({kind:"like",to:q.author,pid:q.id,at:Date.now()});await S.db.doc(`reacts/${S.me}/items/c_1`).set({kind:"c",to:q.author,pid:q.id,text:"おいしそう",at:Date.now()})},"テスト食堂"+R);
    await W(6000);ok("aNotified",await A.p.evaluate(()=>notifs().length>=2));
    ok("cNoReacts",await C.p.evaluate(async()=>(await S.sb.from("reacts").select("id")).data.length===0));
  }catch(e){fails.push("exception: "+e.message)}
  // clean up: every test account deletes itself through the UI (photos first, then the account)
  for(const u of users){try{const p=u.p;p.on("dialog",d=>d.accept());await p.evaluate(()=>go("mine"));await W(500);await p.click("text=アカウントを削除");await W(300);
      await p.fill("#modal input[type=password]",PW);await p.click("#modal button[type=submit]");await p.waitForSelector("#auth:not([hidden])",{timeout:30000});
      ok("deleted_"+u.nick,true)}catch(e){fails.push("delete "+u.nick+": "+e.message)}}
  for(const u of users)if(u.errs.length)out["errs_"+u.nick]=u.errs;
  // the deleted login no longer works
  if(users[0]){const p=users[0].p;await p.fill("#auth input[autocomplete=username]",users[0].id);await p.fill("#auth input[type=password]",PW);await p.click("#auth button[type=submit]");await W(3000);
    ok("loginGone",!(await p.evaluate(()=>!!S.me)))}
  await b.close();console.log(JSON.stringify(out,null,1));if(fails.length){console.log("FAILED:",fails.join(", "));process.exit(1)}console.log("ALL OK")})();
