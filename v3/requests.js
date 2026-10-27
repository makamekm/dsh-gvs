// Only unambiguous progress questions are read-only. Any mixed product change,
// cancellation, attachment or unknown clause remains ordinary human steering.
const statusClause=/^(?:(?:скажи|покажи|расскажи|напиши)(?: мне)?[,:]?\s+)?(?:какой(?: сейчас| текущий)? статус(?: задачи| работы| агентов| команды)?|статус(?: работы| задачи| агентов| команды)?|что(?: сейчас)? делают агенты|чем(?: сейчас)? занят[аы]?(?: агенты| команда)?|как(?:ой)? прогресс|как (?:ид[её]т|продвигается) (?:работа|задача)|что (?:уже )?готово|сколько (?:ещ[её] )?осталось|ну что(?: там)?|есть (?:новости|результат|прогресс)|как дела(?: с задачей| у агентов)?|что(?: сейчас)? в (?:процессе|работе)(?: и на очереди)?|что (?:на очереди|дальше|осталось)|что (?:уже )?сделано|(?:как )?(?:сейчас|теперь)|status(?: update)?|what(?:'s| is) (?:the )?(?:status|progress)|what are (?:the )?agents doing|how(?:'s| is) (?:it|the work|the task) (?:going|progressing)|what(?:'s| is) next|what is in progress)$/iu;
const clause=text=>statusClause.test(text.trim().replace(/^(?:и|а|and)\s+/iu,'').replace(/[?!.…]+$/u,'').trim());
export function isStatusText(text){
 if(typeof text!=='string'||text.length>320||!text.trim())return false;
 if(clause(text))return true;
 const parts=text.split(/[?!.;\n…]+|,(?=\s*(?:что|как|сколько|what|how)(?:\s|$))/iu).map(t=>t.trim()).filter(Boolean);
 return parts.length>1&&parts.every(clause);
}
export function isStatusQuestion(message){return message?.source?.kind==='user'&&message.content?.length>0&&message.content.every(part=>part.type==='text')&&isStatusText(message.content.map(part=>part.text).join(' '));}
