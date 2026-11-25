import {supabaseStore} from '../_shared/store.ts';
import {json} from '../_shared/types.ts';
import {auth} from '../news-ingest/index.ts';
import {safeFunctionError} from '../_shared/diagnostics.ts';
export {auth};

if (import.meta.main) Deno.serve(async req=>{
  if(!auth(req)) return json({ok:false,error:'Cron auth galat'},401);
  try { return json({ok:true,removed:await supabaseStore().clean()}); }
  catch(e) {
    const error=safeFunctionError(e);
    console.error('[news-clean] failed:',error);
    return json({ok:false,error},500);
  }
});
