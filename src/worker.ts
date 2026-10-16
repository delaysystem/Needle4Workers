// Needle RPC integration disabled at user request.
// import { WorkerEntrypoint } from "cloudflare:workers";
// import { prepareToolsForNeedle } from "./lib/tool-pruner";
// export { default } from "./index";
// 
// /** Internal tool activation endpoint; callers supply only their authorized candidates. */
// export class NeedleRpc extends WorkerEntrypoint<Env> {
//   async activate(input: {query:string;tools:unknown[];maxTools?:number}) {
//     if(!input || typeof input.query!=="string" || input.query.length>131072 || !Array.isArray(input.tools) || input.tools.length>200 || JSON.stringify(input.tools).length>131072)throw new Error("NEEDLE_INPUT_INVALID");
//     const maximum=input.maxTools??5;
//     if(!Number.isInteger(maximum)||maximum<1||maximum>20)throw new Error("NEEDLE_LIMIT_INVALID");
//     return prepareToolsForNeedle(input.tools,input.query,maximum);
//   }
// }
