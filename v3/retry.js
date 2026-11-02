// Which stopped turns are worth continuing automatically: normal stops and transient provider/network failures.
export function retryableStop(reason){
 if(['completed','max-tokens','interrupted'].includes(reason?.kind))return true;
 if(reason?.kind!=='error')return false;
 const error=reason.error??{};
 // Provider outages arrive as code SERVER/TRANSPORT/EMPTY_RESPONSE, often with an HTML "try again later" page.
 if(['SERVER','TRANSPORT','EMPTY_RESPONSE','TIMEOUT','RATE_LIMIT'].includes(String(error.code).toUpperCase()))return true;
 return error.retryable===true||/overload|rate.?limit|temporar|timeout|timed.?out|try again later|unable to load site|bad gateway|service unavailable|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|context.{0,20}(?:overflow|exceed)|CONTEXT_WINDOW_EXCEEDED|\b(?:429|500|502|503|504|520|521|522|523|524)\b/iu.test(`${error.code??''} ${error.message??''}`);
}
