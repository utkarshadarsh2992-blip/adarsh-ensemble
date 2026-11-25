import {supabaseStore} from '../_shared/store.ts';import {handleApi} from '../_shared/api.ts';if (import.meta.main) Deno.serve(req=>handleApi(req,supabaseStore()));
