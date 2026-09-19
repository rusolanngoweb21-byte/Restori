import { parse } from "tldts";
import { domainToUnicode } from "node:url";
import { isIP } from "node:net";
import { LruCache, SingleFlight } from "./cache.ts";

export type Signal = { id: string; group: string; label: string; status: "pass"|"warn"|"danger"|"unknown"|"info"; detail: string; source: string; weight: number };
export type Report = { displayUrl: string; domain: string; kind: "website"|"social"|"app"; kindLabel: string; checkedAt: string; checked: number; level: "high"|"attention"|"unknown"|"limited"; verdict: string; summary: string; limitation: string; nextSteps: string[]; signals: Signal[] };
type Dns = { Status: number; AD?: boolean; Answer?: {type:number;data:string}[] };
type Rdap = { ldhName?: string; unicodeName?: string; events?: {eventAction:string;eventDate:string}[]; status?: string[]; entities?: {roles?:string[];vcardArray?:unknown[]}[]; secureDNS?:{delegationSigned?:boolean} };
type AppleResult = { resultCount: number; results?: {trackId?:number;trackName?:string;sellerName?:string;artistName?:string;releaseDate?:string;currentVersionReleaseDate?:string;userRatingCount?:number;averageUserRating?:number}[] };
export type Evidence = { a:Dns|null; aaaa:Dns|null; mx:Dns|null; txt:Dns|null; dmarc:Dns|null; ns:Dns|null; rdap:Rdap|null; apple:AppleResult|null; rdapSource:string };
const brands = [
  {name:"Instagram",key:"instagram",domains:["instagram.com"]},{name:"Facebook",key:"facebook",domains:["facebook.com","fb.com","fb.me"]},{name:"Telegram",key:"telegram",domains:["telegram.org","t.me","telegram.me"]},{name:"WhatsApp",key:"whatsapp",domains:["whatsapp.com","wa.me"]},{name:"TikTok",key:"tiktok",domains:["tiktok.com"]},{name:"YouTube",key:"youtube",domains:["youtube.com","youtu.be"]},{name:"LinkedIn",key:"linkedin",domains:["linkedin.com"]},{name:"X",key:"twitter",domains:["x.com","twitter.com","t.co"]},{name:"ВКонтакте",key:"vkontakte",domains:["vk.com","vk.ru"]},{name:"Одноклассники",key:"odnoklassniki",domains:["ok.ru"]},{name:"Apple",key:"apple",domains:["apple.com","icloud.com"]},{name:"Google",key:"google",domains:["google.com","google.ru","google.co.uk","google.de","google.fr","google.co.in","google.com.br"]},{name:"Microsoft",key:"microsoft",domains:["microsoft.com","live.com","outlook.com"]},{name:"PayPal",key:"paypal",domains:["paypal.com","paypal.me"]},{name:"Amazon",key:"amazon",domains:["amazon.com","amazon.co.uk","amazon.de","amazon.fr","amazon.in","amazon.co.jp"]},{name:"Сбер",key:"sberbank",domains:["sberbank.ru","sber.ru"]},{name:"Госуслуги",key:"gosuslugi",domains:["gosuslugi.ru"]}
];
const shorteners=["bit.ly","tinyurl.com","t.co","goo.gl","is.gd","cutt.ly","clck.ru","rb.gy","ow.ly","shorturl.at"];
const SOURCE_URL="Анализ адреса · правила v1.0";
const SOURCE_DNS="Cloudflare DNS · открытые записи";
const UNKNOWN="Источник недоступен или не вернул данные. Это не признак подделки.";
const emptyEvidence=():Evidence=>({a:null,aaaa:null,mx:null,txt:null,dmarc:null,ns:null,rdap:null,apple:null,rdapSource:"RDAP"});

export function isNonPublicIP(input:string):boolean {
  const ip=input.replace(/^\[|\]$/g,"").toLowerCase();
  if(isIP(ip)===4){const [a,b,c]=ip.split(".").map(Number);return a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113);}
  if(isIP(ip)===6){if(!/^[23]/.test(ip))return true;return ip.startsWith("2001:db8:")||ip.startsWith("2001:0:")||ip.startsWith("2002:");}
  return true;
}
export function normalizeInput(raw:string):URL {
  if(typeof raw!=="string"||!raw.trim())throw new Error("Вставьте ссылку для проверки.");
  if(raw.length>2048)throw new Error("Ссылка слишком длинная: максимум 2048 символов.");
  if(/[\u0000-\u0020\u007f\\]/.test(raw.trim()))throw new Error("Уберите пробелы и служебные символы из ссылки.");
  let candidate=raw.trim();
  if(!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate))candidate="https://"+candidate;
  let url:URL;try{url=new URL(candidate);}catch{throw new Error("Не удалось распознать адрес. Пример: https://example.com/profile");}
  if(!["https:","http:"].includes(url.protocol))throw new Error("Поддерживаются только ссылки http:// и https://.");
  url.hostname=url.hostname.replace(/\.$/,"");
  const hostname=url.hostname;const ip=hostname.replace(/^\[|\]$/g,"");
  if(isIP(ip)){if(isNonPublicIP(ip))throw new Error("Это локальный или служебный IP-адрес. Вставьте публичную ссылку.");}
  else if(!hostname.includes(".")||hostname.length>253||hostname.split(".").some(v=>!/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(v))||/(^|\.)(localhost|local|internal|lan|home|arpa|onion)$/.test(hostname))throw new Error("Нужен публичный адрес сайта, а не локальное или служебное имя.");
  return url;
}
function editDistance(a:string,b:string):number{if(Math.abs(a.length-b.length)>1)return 3;let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}return row[b.length];}
function confusable(s:string):string{const map:Record<string,string>={"а":"a","е":"e","о":"o","р":"p","с":"c","у":"y","х":"x","і":"i","ј":"j","ӏ":"l","α":"a","ο":"o","ρ":"p","ν":"v","0":"o","1":"l"};return Array.from(s.toLowerCase()).map(c=>map[c]??c).join("").replace(/rn/g,"m").replace(/vv/g,"w");}
function records(d:Dns|null,type:number):string[]{return d?.Status===0?(d.Answer??[]).filter(a=>a.type===type).map(a=>a.data):[];}
function validDns(d:Dns|null):boolean{return !!d&&[0,3].includes(d.Status);}
function getKind(url:URL){const hostname=url.hostname;const platform=brands.slice(0,10).find(b=>b.domains.some(d=>hostname===d||hostname.endsWith("."+d)));const appStore=hostname==="apps.apple.com";const play=hostname==="play.google.com"&&url.pathname.startsWith("/store/apps");const direct=/\.(apk|aab|ipa|exe|msi|dmg|pkg|appx|bat|cmd|ps1|scr|js)$/i.test(url.pathname);const social=!!platform&&url.pathname!=="/";
  return{kind:(appStore||play||direct?"app":social?"social":"website")as Report["kind"],kindLabel:appStore?"Приложение · App Store":play?"Приложение · Google Play":direct?"Ссылка на файл":social?"Социальная страница · "+platform!.name:"Веб-сайт",platform,appStore,play,direct};}

// Only provider endpoints are contacted. The submitted URL is never fetched.
// No browser rendering, scripts, downloads, crawling, cookies or automatic redirects.
const providerCache = new LruCache<unknown>(512);
const providerFlight = new SingleFlight<unknown>();
async function providerJson<T>(target:URL,signal:AbortSignal):Promise<T|null>{
  const key=target.href,cached=providerCache.get(key);if(cached!==undefined)return cached as T|null;
  try{return await providerFlight.run(key,async()=>{
    const value=await uncachedProviderJson<T>(target,signal);
    let ttl=value===null?2000:target.hostname==='cloudflare-dns.com'?30000:300000;
    if(target.hostname==='cloudflare-dns.com'&&value&&typeof value==='object'&&'Answer'in value&&Array.isArray(value.Answer)){
      const durations=value.Answer.map((a:unknown)=>a&&typeof a==='object'&&'TTL'in a&&typeof a.TTL==='number'?Math.max(0,a.TTL*1000):30000);
      ttl=Math.min(ttl,...durations);
    }
    if(ttl>0)providerCache.set(key,value,ttl);return value;
  }) as T|null;}catch{return null;}
}
async function uncachedProviderJson<T>(target:URL,signal:AbortSignal):Promise<T|null>{
  try{const response=await fetch(target,{headers:{Accept:"application/dns-json, application/rdap+json, application/json"},redirect:"manual",signal});if(!response.ok){await response.body?.cancel();return null;}const reader=response.body?.getReader();if(!reader)return null;let bytes=0;let text="";const decoder=new TextDecoder();try{while(true){const{done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>512_000){await reader.cancel();return null;}text+=decoder.decode(value,{stream:true});}}finally{reader.releaseLock();}return JSON.parse(text+decoder.decode())as T;}catch{return null;}
}
let rdapBootstrap:{expires:number;services:[string[],string[]][]}|null=null;
async function registration(domain:string,signal:AbortSignal):Promise<{data:Rdap|null;source:string}>{
  try{if(!rdapBootstrap||rdapBootstrap.expires<Date.now()){const bootstrap=await providerJson<{services:[string[],string[]][]}>(new URL("https://data.iana.org/rdap/dns.json"),signal);if(!Array.isArray(bootstrap?.services))return{data:null,source:"RDAP · каталог IANA недоступен"};rdapBootstrap={expires:Date.now()+3600_000,services:bootstrap.services};}
    const tld=domain.split(".").at(-1)!;const service=rdapBootstrap.services.find(v=>Array.isArray(v[0])&&v[0].includes(tld));const endpoint=service?.[1]?.find(v=>v.startsWith("https://"));if(!endpoint)return{data:null,source:"RDAP · нет сервиса для этой доменной зоны"};
    const base=new URL(endpoint);if(base.protocol!=="https:"||base.username||base.password||base.port||isIP(base.hostname)||!base.hostname.includes(".")||/(^|\.)(localhost|local|internal|arpa)$/.test(base.hostname))return{data:null,source:"RDAP"};
    const target=new URL("domain/"+encodeURIComponent(domain),base.href.endsWith("/")?base.href:base.href+"/");const data=await providerJson<Rdap>(target,signal);if(!data||typeof data!=="object"||typeof data.ldhName!=="string"||data.ldhName.toLowerCase()!==domain.toLowerCase())return{data:null,source:"RDAP · "+base.hostname};return{data,source:"RDAP · "+base.hostname};
  }catch{return{data:null,source:"RDAP"};}
}
export async function collectEvidence(url:URL):Promise<Evidence>{
  const e=emptyEvidence();const p=parse(url.hostname);if(p.isIp||!p.isIcann||!p.domain||/(^|\.)(example|test|invalid)$/.test(url.hostname))return e;
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10500);
  const dns=(name:string,type:string)=>{const u=new URL("https://cloudflare-dns.com/dns-query");u.searchParams.set("name",name);u.searchParams.set("type",type);return providerJson<Dns>(u,AbortSignal.any([controller.signal,AbortSignal.timeout(2500)]));};
  const kind=getKind(url);const id=kind.appStore?url.pathname.match(/\/id(\d{5,15})(?:\/|$)/)?.[1]:undefined;const country=kind.appStore?(url.pathname.split("/")[1]||"us"):"us";const appUrl=new URL("https://itunes.apple.com/lookup");if(id){appUrl.searchParams.set("id",id);appUrl.searchParams.set("entity","software");appUrl.searchParams.set("country",/^[a-z]{2}$/.test(country)?country:"us");}
  const rdapTask=registration(p.domain,controller.signal);const appleTask=id?providerJson<AppleResult>(appUrl,controller.signal):Promise.resolve(null);
  try{const results=await Promise.allSettled([dns(url.hostname,"A"),dns(url.hostname,"AAAA"),dns(p.domain,"MX"),dns(p.domain,"TXT"),dns("_dmarc."+p.domain,"TXT"),dns(p.domain,"NS"),rdapTask,appleTask]);
    const take=(i:number)=>results[i].status==="fulfilled"?results[i].value:null;
    e.a=take(0)as Dns|null;e.aaaa=take(1)as Dns|null;e.mx=take(2)as Dns|null;e.txt=take(3)as Dns|null;e.dmarc=take(4)as Dns|null;e.ns=take(5)as Dns|null;const r=take(6)as Awaited<ReturnType<typeof registration>>|null;e.rdap=r?.data??null;e.rdapSource=r?.source??"RDAP";e.apple=take(7)as AppleResult|null;return e;
  }finally{clearTimeout(timeout);}
}

export function evaluate(raw:string,url:URL,e:Evidence,now=Date.now()):Report{
  const signals:Signal[]=[];const add=(id:string,group:string,label:string,status:Signal["status"],detail:string,source=SOURCE_URL,weight=0)=>signals.push({id,group,label,status,detail,source,weight});
  const U="Адрес и домен",D="Инфраструктура",R="Регистрация",I="Подлинность";
  const p=parse(url.hostname,{allowPrivateDomains:true});const reg=parse(url.hostname);const host=url.hostname;const domain=p.domain??host;const unicode=domainToUnicode(host);const label=domainToUnicode(p.domainWithoutSuffix??"");const k=getKind(url);const familiar=brands.find(b=>b.domains.some(d=>host===d||host.endsWith("."+d)));
  const schemeProvided=/^https?:\/\//i.test(raw.trim());
  add("https",U,"Протокол в ссылке",url.protocol==="http:"?"warn":schemeProvided?"pass":"info",url.protocol==="http:"?"В ссылке указан HTTP без шифрования. Возможное перенаправление на HTTPS не проверяется.":schemeProvided?"В адресе указан HTTPS. Наличие и действительность сертификата отдельно не проверялись.":"Протокол не указан: для разбора добавлен HTTPS. Поддержка HTTPS сайтом не проверена.",SOURCE_URL,url.protocol==="http:"?8:0);
  add("userinfo",U,"Скрытый адрес после @",url.username||url.password?"danger":"pass",url.username||url.password?"В адресе есть блок перед @. Настоящий сервер: "+host+". Содержимое блока скрыто.":"Блок учётных данных перед доменом отсутствует.",SOURCE_URL,url.username||url.password?45:0);
  add("ip",U,"IP вместо домена",p.isIp?"warn":"pass",p.isIp?"Используется IP-адрес. Сопоставить его с именем организации сложнее.":"Указано доменное имя.",SOURCE_URL,p.isIp?10:0);
  add("idn",U,"Международное доменное имя",host.includes("xn--")?"info":"pass",host.includes("xn--")?"Используется международное имя (Punycode): "+unicode+". Само по себе это нормально.":"В домене нет Punycode-кодирования.");
  const mixed=unicode.split(".").some(s=>/[a-z]/i.test(s)&&/[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(s));
  add("mixed",U,"Смешение похожих алфавитов",mixed?"warn":"pass",mixed?"В одной части домена смешаны латиница и кириллица или греческие буквы. Проверьте написание.":"Смешение латиницы с кириллицей или греческими буквами в одном сегменте не найдено.",SOURCE_URL,mixed?16:0);
  const bidi=/[\u202a-\u202e\u2066-\u2069]/.test(raw)||/%e2%80%a[a-e]|%e2%81%a[6-9]/i.test(raw);
  add("bidi",U,"Управление направлением текста",bidi?"danger":"pass",bidi?"Найдены символы, меняющие визуальный порядок текста. Отображаемая ссылка может вводить в заблуждение.":"Такие управляющие символы не найдены.",SOURCE_URL,bidi?40:0);
  const shortened=shorteners.includes(domain);add("short",U,"Сокращённая ссылка",shortened?"warn":"pass",shortened?"Это сервис сокращения ссылок. Конечный адрес не раскрыт и не проверен.":"Домен не входит в встроенный список из "+shorteners.length+" популярных сокращателей.",SOURCE_URL,shortened?8:0);
  const subBrand=!familiar?brands.find(b=>b.domains.some(d=>host.startsWith(d+".")||host.includes("."+d+"."))):undefined;
  add("subbrand",U,"Чужой бренд в поддомене",subBrand?"danger":"pass",subBrand?"Имя "+subBrand.name+" расположено внутри чужого адреса. Управляющий домен: "+domain+".":"Встроенные домены известных сервисов не найдены перед чужим управляющим доменом.",SOURCE_URL,subBrand?45:0);
  const typo=!familiar?brands.find(b=>b.key.length>=5&&label.length>=4&&(confusable(label)===b.key||editDistance(label,b.key)===1)):undefined;
  add("typo",U,"Сходство с известным брендом",typo?"warn":"pass",typo?"Название похоже на "+typo.name+", но адрес не совпадает с доменами из справочника. Это эвристика, возможны совпадения.":"Близкое написание не найдено среди "+brands.length+" встроенных брендов. Список не охватывает все организации.",SOURCE_URL,typo?28:0);
  const decorated=!familiar&&!typo?brands.find(b=>b.key.length>=5&&label.includes(b.key)):undefined;
  add("decorated",U,"Бренд с добавленными словами",decorated?"warn":"pass",decorated?"В домене присутствует "+decorated.name+" с другим окончанием или добавленными словами. Это может быть независимый сайт; связь с брендом не подтверждена.":"Совпадений с этим правилом в справочнике не найдено.",SOURCE_URL,decorated?14:0);
  add("length",U,"Длина имени домена",domain.length>45?"warn":"pass",domain.length>45?"Длинное имя: "+domain.length+" символов. Это слабый признак, не доказательство подделки.":"Длина имени: "+domain.length+" символов.",SOURCE_URL,domain.length>45?2:0);
  const depth=p.subdomain?.split(".").filter(Boolean).length??0;add("depth",U,"Вложенность поддоменов",depth>3?"warn":"pass","Уровней перед управляющим доменом: "+depth+". "+(depth>3?"Сложный адрес легче неверно прочитать.":"Чрезмерная вложенность не обнаружена."),SOURCE_URL,depth>3?3:0);
  const dashes=(label.match(/-/g)??[]).length;add("dashes",U,"Разделители в названии",dashes>3?"warn":"pass","Дефисов в основном имени: "+dashes+". Этот признак сам по себе не определяет подлинность.",SOURCE_URL,dashes>3?2:0);
  add("port",U,"Нестандартный порт",url.port?"warn":"pass",url.port?"Указан нестандартный веб-порт "+url.port+". Такое бывает и у законных сервисов.":"В адресе нет нестандартного порта.",SOURCE_URL,url.port?5:0);
  const encoding=/%(?:25|2f|40|3a)/i.test(url.pathname);add("encoding",U,"Скрытые разделители в пути",encoding?"info":"pass",encoding?"В пути есть закодированные разделители. Они могут быть нужны приложению; содержимое пути не открывалось.":"Проверяемые закодированные разделители в пути не найдены.");
  const redirects=[...url.searchParams].filter(([key,v])=>/^(url|u|redirect|redirect_uri|redirect_url|return|returnurl|next|target|dest|destination|continue)$/i.test(key)&&/^https?:\/\//i.test(v));const external=redirects.some(([,v])=>{try{return parse(new URL(v).hostname,{allowPrivateDomains:true}).domain!==domain;}catch{return false;}});
  add("redirect",U,"Внешний адрес в параметрах",external?"warn":"pass",external?"Параметр ссылки указывает на другой домен. Возможный переход не выполнялся; содержимое параметров скрыто.":"Среди проверяемых параметров явный переход на другой домен не найден. Серверные перенаправления не проверялись.",SOURCE_URL,external?8:0);
  const secret=[...url.searchParams.keys()].some(key=>/token|password|passwd|secret|session|api.?key|auth|signature/i.test(key));add("secret",U,"Чувствительные параметры",secret?"warn":"pass",secret?"Есть параметр, похожий на токен доступа. Не передавайте такую ссылку другим людям. Значение скрыто.":"Характерные имена параметров доступа не найдены. Это не гарантирует отсутствия секретов.");
  add("download",U,"Прямая ссылка на программу",k.direct?"warn":"pass",k.direct?"Адрес заканчивается расширением исполняемого файла. Файл не скачивался и не анализировался.":"Путь не заканчивается проверяемыми расширениями программ. Фактический тип ответа неизвестен.",SOURCE_URL,k.direct?12:0);
  const ips=[...records(e.a,1),...records(e.aaaa,28)];const dnsKnown=validDns(e.a)&&validDns(e.aaaa);const resolves=ips.length>0;
  add("dns",D,"Разрешение доменного имени",resolves?"pass":dnsKnown?"info":"unknown",resolves?"DNS вернул "+ips.length+" адрес(а) сервера. Доступность страницы из этого не следует.":dnsKnown?"Публичные A/AAAA-записи не найдены. Возможны опечатка, настройка домена или временная проблема.":UNKNOWN,SOURCE_DNS);
  const privateIp=ips.some(isNonPublicIP);add("public",D,"Публичность DNS-адресов",!resolves?"unknown":privateIp?"warn":"pass",!resolves?"Нет адресов для оценки.":privateIp?"В публичном DNS есть локальные или специальные адреса. Обращение к ним не выполняется.":"Полученные адреса не входят в проверяемые локальные и специальные диапазоны.",SOURCE_DNS,privateIp?12:0);
  add("ns",D,"Серверы имён",validDns(e.ns)?"info":"unknown",validDns(e.ns)?"NS-записей управляющего домена: "+records(e.ns,2).length+". Это техническая характеристика, не оценка владельца.":UNKNOWN,SOURCE_DNS);
  add("mx",D,"Почтовая инфраструктура",validDns(e.mx)?"info":"unknown",validDns(e.mx)?"MX-записей: "+records(e.mx,15).length+". Сайт не обязан принимать почту.":UNKNOWN,SOURCE_DNS);
  const spf=records(e.txt,16).some(v=>/v=spf1/i.test(v));add("spf",D,"Защита почты SPF",validDns(e.txt)?"info":"unknown",validDns(e.txt)?(spf?"Политика SPF опубликована.":"SPF не найден в ответе DNS.")+" Это не подтверждает подлинность сайта.":UNKNOWN,SOURCE_DNS);
  const dmarc=records(e.dmarc,16).some(v=>/v=DMARC1/i.test(v));add("dmarc",D,"Защита почты DMARC",validDns(e.dmarc)?"info":"unknown",validDns(e.dmarc)?(dmarc?"Политика DMARC опубликована.":"DMARC не найден в ответе DNS.")+" Отсутствие не означает мошенничество.":UNKNOWN,SOURCE_DNS);
  add("dnssec",D,"Проверка DNSSEC",validDns(e.a)?"info":"unknown",validDns(e.a)?(e.a?.AD?"Резолвер отметил ответ как криптографически подтверждённый (AD).":"В ответе нет отметки AD. Это не признак подделки."):UNKNOWN,SOURCE_DNS);
  const rd=e.rdap;const source=e.rdapSource;const events=Array.isArray(rd?.events)?rd.events:[];const dateOf=(name:string)=>{const v=events.find(v=>v.eventAction===name)?.eventDate;const n=v?Date.parse(v):NaN;return Number.isFinite(n)?n:null;};const created=dateOf("registration");const age=created!==null&&created<=now?Math.floor((now-created)/86400000):null;const expires=dateOf("expiration");const changed=dateOf("last changed");const fmt=(n:number)=>new Date(n).toLocaleDateString("ru-RU",{timeZone:"UTC"});
  add("rdap",R,"Запись в реестре",rd?"info":"unknown",rd?"Получены регистрационные сведения для "+reg.domain+(p.isPrivate?". Это домен хостинга; возраст конкретной страницы неизвестен.":"."):UNKNOWN,source);
  add("age",R,"Возраст регистрации",age===null?"unknown":p.isPrivate?"info":age<30?"warn":age<180?"warn":"info",age===null?"Дата регистрации не получена.":"Зарегистрирован "+fmt(created!)+"; возраст — "+age+" дн. "+(p.isPrivate?"Дата относится к хостингу, а не к странице.":age<180?"Новый домен требует дополнительной проверки, но может быть законным.":"Старый домен тоже может сменить владельца или быть взломан."),source,age!==null&&!p.isPrivate?(age<30?20:age<180?8:0):0);
  add("expiry",R,"Срок регистрации",expires===null?"unknown":"info",expires===null?"Срок не опубликован или источник недоступен.":"Дата из реестра: "+fmt(expires)+". Срок не доказывает подлинность.",source);
  add("changed",R,"Изменение записи",changed===null?"unknown":"info",changed===null?"Дата изменения записи не получена.":"Последнее изменение: "+fmt(changed)+". Это не обязательно смена владельца.",source);
  const registrar=rd?.entities?.find(v=>v.roles?.includes("registrar"));let registrarName="";const vcard=registrar?.vcardArray?.[1];if(Array.isArray(vcard)){const fn=vcard.find(v=>Array.isArray(v)&&v[0]==="fn");if(Array.isArray(fn)&&typeof fn[3]==="string")registrarName=fn[3].slice(0,160);}
  add("registrar",R,"Регистратор",registrarName?"info":"unknown",registrarName?"Регистратор: "+registrarName+". Это не проверка личности владельца.":"Название регистратора не получено.",source);
  const statuses=Array.isArray(rd?.status)?rd.status.filter(s=>typeof s==="string").slice(0,8):[];const held=statuses.some(s=>/^(client|server)\s?hold$/i.test(s));add("hold",R,"Статус регистрации",!rd?"unknown":held?"warn":"info",!rd?UNKNOWN:statuses.length?"Статусы: "+statuses.join(", ")+". "+(held?"Делегирование домена приостановлено; причина не установлена.":"Технические статусы не определяют добросовестность владельца."):"Реестр не перечислил статусы.",source,held?10:0);
  add("platform",I,"Совпадение с доменом платформы",familiar?"info":"unknown",familiar?"Адрес находится на домене из справочника "+familiar.name+". Это подтверждает только совпадение адреса, а не владельца страницы.":"Домен не сопоставлен со встроенным справочником. Это нормально для независимых сайтов.");
  add("tls",I,"Сертификат и содержимое страницы","unknown","Соединение с проверяемым сайтом не устанавливалось. Сертификат, формы и содержимое страницы не проверены.","Требуется дополнительная проверка");
  add("reputation",I,"Базы фишинга и вредоносных ссылок","unknown","Репутационные базы в этой версии не подключены. Отсутствие предупреждений не означает, что адрес в них отсутствует.","Источник не подключён");
  add("identity",I,"Личность и полномочия владельца","unknown","По этой ссылке личность владельца и его связь с заявленным брендом не подтверждены.","Требуется независимое подтверждение");
  if(k.kind==="social"){
    add("profileAge",I,"Дата создания аккаунта","unknown","Возраст домена соцсети не является возрастом аккаунта. Дата создания профиля недоступна.","Данные платформы не получены");
    add("photo",I,"Подлинность фотографии","unknown","Обратный поиск изображения и проверка происхождения фото не проводились.","Источник не подключён");
    add("posts",I,"История публикаций и аудитории","unknown","Посты, подписчики и изменения имени не получены. Оценка накрутки не выполнялась.","Данные платформы не получены");
    add("verified",I,"Подтверждение платформой","unknown","Значок верификации и его тип не проверены. Публичное имя не доказывает личность.","Данные платформы не получены");
  }
  if(k.kind==="app"){
    const id=k.appStore?url.pathname.match(/\/id(\d{5,15})(?:\/|$)/)?.[1]:undefined;const app=id?e.apple?.results?.find(v=>String(v.trackId)===id):undefined;
    add("store",I,"Адрес магазина приложений",k.appStore||k.play?"info":"warn",k.appStore||k.play?"Ссылка использует домен "+(k.appStore?"App Store":"Google Play")+". Это не подтверждает разработчика и безопасность приложения.":"Это не распознанная страница App Store или Google Play. Устанавливайте приложение только после проверки издателя.",SOURCE_URL,k.appStore||k.play?0:8);
    add("listing",I,"Карточка приложения",app?"info":"unknown",app?"В каталоге Apple найдена карточка: "+String(app.trackName??"Без названия").slice(0,160)+".":"Карточка не получена. Причиной может быть регион, удаление приложения или недоступность источника.",k.appStore?"Apple Lookup API":"Источник не подключён");
    add("publisher",I,"Имя издателя в каталоге",app?.sellerName||app?.artistName?"info":"unknown",app?"Издатель из каталога: "+String(app.sellerName??app.artistName??"не указан").slice(0,160)+". Связь с брендом нужно подтвердить отдельно.":"Данные издателя не получены.",k.appStore?"Apple Lookup API":"Источник не подключён");
    add("appupdated",I,"Дата обновления приложения",app?.currentVersionReleaseDate?"info":"unknown",app?.currentVersionReleaseDate?"Дата из каталога: "+String(app.currentVersionReleaseDate).slice(0,10)+". Частые обновления не гарантируют безопасность.":"Дата обновления не получена.",k.appStore?"Apple Lookup API":"Источник не подключён");
    add("binary",I,"Подпись и код приложения","unknown","Установочный файл не загружался. Цифровая подпись, разрешения и вредоносный код не анализировались.","Требуется отдельная проверка файла");
  }
  const important=signals.filter(s=>s.weight>=8);const strong=signals.some(s=>s.status==="danger"&&s.weight>=40);const brandRisk=Math.max(0,...signals.filter(s=>["subbrand","typo","decorated","mixed"].includes(s.id)).map(s=>s.weight));const otherRisk=signals.filter(s=>!["subbrand","typo","decorated","mixed"].includes(s.id)).reduce((n,s)=>n+s.weight,0);
  const high=strong||(brandRisk>=20&&otherRisk>=16&&important.length>=2);
  const warning=signals.some(s=>["warn","danger"].includes(s.status));
  const level:Report["level"]=high?"high":warning?"attention":k.kind!=="website"||!resolves||!rd?"unknown":"limited";
  const verdict={high:"Высокий риск подмены",attention:"Требует внимания",unknown:"Недостаточно данных",limited:"Явные сигналы не найдены"}[level];
  const summary=level==="high"?"Найдены сильные признаки маскировки адреса или сочетание настораживающих признаков. Не вводите пароли и платёжные данные по этой ссылке.":level==="attention"?"Есть признаки, которые стоит проверить вручную. Они не доказывают, что перед вами подделка.":level==="unknown"?"Доступных сведений недостаточно, чтобы подтвердить подлинность. Посмотрите найденные факты и ограничения ниже.":"В доступных данных явные признаки подмены не обнаружены. Безопасность сайта и личность владельца не подтверждены.";
  const limitation=k.kind==="social"?"Проверен адрес страницы. Настоящий домен соцсети не означает настоящий аккаунт. Личность, публикации и фотографии владельца не подтверждены.":k.kind==="app"?"Проверена ссылка и доступные сведения каталога. Код приложения, его подпись и связь издателя с брендом не проверены.":"Проверены адрес и открытые сведения о домене. Содержимое сайта, сертификат, репутационные базы и личность владельца не проверены.";
  const nextSteps=k.kind==="social"?["Найдите ссылку на этот профиль на официальном сайте человека или организации.","Подтвердите личность через ранее известный канал связи.","Не переводите деньги и не сообщайте коды входа по просьбе незнакомого аккаунта."]:k.kind==="app"?["Перейдите в магазин по ссылке с официального сайта разработчика.","Сверьте точное имя издателя и адрес его сайта.","Проверьте разрешения и подпись установочного файла перед установкой."]:["Откройте официальный адрес организации из независимого источника.","Сверьте реквизиты и контакты с независимыми данными.","Не вводите платёжные данные, пока сомнения не разрешены."];
  const displayUrl=url.protocol+"//"+host+(url.port?":"+url.port:"")+url.pathname+(url.search?"?[параметры скрыты]":"")+(url.hash?"#[фрагмент скрыт]":"");
  return{displayUrl,domain,kind:k.kind,kindLabel:k.kindLabel,checkedAt:new Date(now).toISOString(),checked:signals.filter(s=>s.status!=="unknown").length,level,verdict,summary,limitation,nextSteps,signals};
}
export async function analyzeLink(raw:string):Promise<Report>{const url=normalizeInput(raw);return evaluate(raw,url,await collectEvidence(url));}
