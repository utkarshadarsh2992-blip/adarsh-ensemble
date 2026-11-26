import {supabaseStore} from '../_shared/store.ts';
import {handleApi} from '../_shared/api.ts';
import {json} from '../_shared/types.ts';
import {safeFunctionError} from '../_shared/diagnostics.ts';

const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'content-type, x-app-secret','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'};

if (import.meta.main) Deno.serve(async req=>{
  try {
    return await handleApi(req,supabaseStore());
  } catch (e) {
    const error=safeFunctionError(e);
    console.error('[news-api] initialization failed:',error);
    return json({ok:false,error:'Backend initialization error'},500,headers);
  }
});
