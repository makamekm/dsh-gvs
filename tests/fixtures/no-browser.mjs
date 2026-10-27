import {fileURLToPath} from 'node:url';
const type={executablePath:()=>fileURLToPath(new URL('./intentionally-absent-browser',import.meta.url)),launch:async()=>{throw new Error('TEST FIXTURE: no actual browser is launched');}};
export {type as chromium,type as firefox,type as webkit};
