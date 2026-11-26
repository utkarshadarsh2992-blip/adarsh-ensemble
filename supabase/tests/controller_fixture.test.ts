import {assert,assertEquals} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {validateConfig,ControllerFault} from '../functions/_shared/controller.ts';
const cases=JSON.parse(await Deno.readTextFile(new URL('../functions/_shared/fixtures/controller_config_cases.json',import.meta.url)));
for(const item of cases){Deno.test(`shared controller fixture: ${item.name}`,()=>{let ok=true;try{validateConfig(item.config)}catch(e){ok=false;assert(e instanceof ControllerFault)}assertEquals(ok,item.valid)})}
Deno.test('revision-6 fixture keeps the saved structural shape',()=>{const item=cases.find((x:any)=>x.name==='revision-6-shape-anonymized');assertEquals(item.config.models.length,34);assertEquals(Object.keys(item.config.routes).length,99);});
