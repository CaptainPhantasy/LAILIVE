import { HttpError } from './concierge/contracts.js';
export function withBoardLead(handler,getStore){
 return async request=>{
  if(request.method!=='POST')return handler(request);
  const headers={'Cache-Control':'no-store'};
  try{
   if(request.headers.get('origin') && request.headers.get('origin')!==new URL(request.url).origin)throw new HttpError(403,'Use the Board from this website.');
   const id=request.headers.get('x-legacy-inquiry');
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id||''))throw new HttpError(403,'Add your contact details so Douglas can understand your question.');
   const store=getStore(), inquiry=await store.getInquiry(id);
   const choices=inquiry?.consent?.filter(c=>c.purpose==='inquiry-reply')||[];
   if(!inquiry || choices.at(-1)?.choice!=='granted')throw new HttpError(403,'Please review the contact step before asking the Board.');
   const now=new Date(),hour=now.toISOString().slice(0,13),day=now.toISOString().slice(0,10);
   await store.consumeLimits([{key:`board:${hour}:${id}`,limit:4,expiresAt:new Date(now.getTime()+86400000).toISOString()},{key:`board:${day}`,limit:20,expiresAt:new Date(now.getTime()+86400000).toISOString()}]);
   return handler(request);
  }catch(e){return Response.json({error:e instanceof HttpError?e.message:'The contact step could not be verified. Please try again.'},{status:e instanceof HttpError?e.status:503,headers});}
 };
}
