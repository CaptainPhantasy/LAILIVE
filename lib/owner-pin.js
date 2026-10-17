import { randomBytes, scryptSync, createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
export async function ownerPinHash(db) {
 await db.execute(sql.raw("CREATE TABLE IF NOT EXISTS legacy_owner_settings (name text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())"));
 await db.execute(sql.raw('ALTER TABLE legacy_owner_settings ENABLE ROW LEVEL SECURITY'));
 return (await db.execute(sql`SELECT value FROM legacy_owner_settings WHERE name='phone_pin'`)).rows[0]?.value;
}
export function createOwnerPinHandler({getDb, authorize, env=process.env}) {
 return async request => {
  try {
   if(request.method!=='POST')return Response.json({error:'POST required.'},{status:405});
   const setup=request.headers.get('x-owner-pin-setup');
   let firstSetup=false;
   if(setup && env.FRONTDESK_PIN_SETUP_HASH && Date.now()<Number(env.FRONTDESK_PIN_SETUP_EXPIRES)){
    const actual=createHash('sha256').update(setup).digest('hex');
    firstSetup=actual.length===env.FRONTDESK_PIN_SETUP_HASH.length && timingSafeEqual(Buffer.from(actual),Buffer.from(env.FRONTDESK_PIN_SETUP_HASH));
   }
   if(!firstSetup)await authorize(request);
   const raw=await request.text();if(Buffer.byteLength(raw)>500)return Response.json({error:'Request too large.'},{status:413});
   const {pin,confirm}=JSON.parse(raw);
   if(typeof pin!=='string'||!/^[0-9]{6,12}$/.test(pin)||pin!==confirm)return Response.json({error:'Enter the same PIN twice, using 6 to 12 digits.'},{status:400});
   const db=getDb();await ownerPinHash(db);
   const salt=randomBytes(16).toString('hex'),hash=scryptSync(pin,salt,32).toString('hex');
   if(firstSetup){
    const saved=await db.execute(sql`INSERT INTO legacy_owner_settings(name,value) VALUES ('phone_pin',${salt+':'+hash}) ON CONFLICT DO NOTHING RETURNING name`);
    if(!saved.rows.length)return Response.json({error:'A PIN is already set. Use your signed-in owner settings to change it.'},{status:409});
   }else await db.execute(sql`INSERT INTO legacy_owner_settings(name,value) VALUES ('phone_pin',${salt+':'+hash}) ON CONFLICT(name) DO UPDATE SET value=excluded.value,updated_at=now()`);
   return Response.json({saved:true},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return Response.json({error:error.status===401||error.status===403?'Sign in with your owner account.':'PIN could not be saved.'},{status:error.status===401||error.status===403?error.status:500});}
 };
}
