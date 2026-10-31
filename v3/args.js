// Local models often send structured values as JSON text ("[\"a\"]", "true", "3"), a single item for a list,
// a snake_case field name or the whole payload nested in a wrapper object. Repair only these unambiguous
// mismatches against the tool's own JSON schema; everything else is left for the tool to accept or reject.
const types=schema=>[].concat(schema?.type??[]);
const WRAPPERS=['result','args','arguments','params','parameters','input','data','payload'];
const camel=key=>key.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase());
function coerce(value,schema){
 if(!schema||value==null)return value;
 const accepted=types(schema),text=typeof value==='string'&&!accepted.includes('string')?value.trim():null;
 if(text!==null){
  if((accepted.includes('array')&&text.startsWith('['))||(accepted.includes('object')&&text.startsWith('{'))){try{return coerce(JSON.parse(text),schema);}catch{return value;}}
  if(accepted.includes('boolean')&&/^(true|false)$/i.test(text))return text.toLowerCase()==='true';
  if((accepted.includes('integer')||accepted.includes('number'))&&/^-?\d+(\.\d+)?$/.test(text)){const number=Number(text);return accepted.includes('integer')&&!Number.isInteger(number)?value:number;}
  if(accepted.includes('array')&&text&&types(schema.items).includes('string'))return [value];
  return value;
 }
 if(Array.isArray(value)){if(!accepted.includes('array'))return value;const items=value.map(item=>coerce(item,schema.items));return items.some((item,index)=>item!==value[index])?items:value;}
 if(typeof value==='object'&&accepted.includes('object')&&schema.properties)return coerceArgs(value,schema);
 return value;
}
export function coerceArgs(args,schema){
 if(!args||typeof args!=='object'||Array.isArray(args)||!schema?.properties)return args;
 const properties=schema.properties;let changed=false,source=args;
 const wrapper=WRAPPERS.find(key=>!(key in properties)&&source[key]&&typeof source[key]==='object'&&!Array.isArray(source[key])&&Object.keys(source[key]).length&&Object.keys(source[key]).every(name=>name in properties||camel(name) in properties));
 if(wrapper){const {[wrapper]:inner,...rest}=source;source={...inner,...rest};changed=true;}
 const out={};
 for(const [key,value] of Object.entries(source)){
  let name=key;
  if(!(key in properties)){const alias=camel(key);if(alias in properties&&!(alias in source))name=alias;}
  const next=coerce(value,properties[name]);
  if(name!==key||next!==value)changed=true;
  out[name]=next;
 }
 return changed?out:args;
}
