import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";

export function handoffPage(reply: FastifyReply, id: string, launchPath: string): string {
  const nonce = randomBytes(18).toString("base64");
  reply
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
  for (const name of [
    "access-control-allow-origin",
    "access-control-allow-credentials",
    "access-control-expose-headers",
  ])
    reply.removeHeader(name);
  // Only server-created opaque IDs and fixed route paths enter this document.
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connect</title><body><p id="status">Waiting for the initiating Data App.</p><script nonce="${nonce}">
const id=${JSON.stringify(id)}, path=${JSON.stringify(launchPath)};
const openerWindow=window.opener;
if(openerWindow){
  openerWindow.postMessage({type:"integration:ready",transactionId:id},"*");
  const receive=async(event)=>{
    if(event.source!==openerWindow||event.data?.type!=="integration:proof"||event.data.transactionId!==id||typeof event.data.initiationProof!=="string")return;
    window.removeEventListener("message",receive);
    try{
      const result=await fetch(path,{method:"POST",credentials:"same-origin",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify({initiationProof:event.data.initiationProof})});
      if(!result.ok)throw new Error("Authorization unavailable");
      const data=await result.json();location.replace(data.authorizationUrl);
    }catch{document.getElementById("status").textContent="Authorization is unavailable. Return to the Data App.";openerWindow.postMessage({type:"integration:failed",transactionId:id},"*");}
  };window.addEventListener("message",receive);
}else{document.getElementById("status").textContent="Open this window from your Data App.";}
</script></body></html>`;
}
export function completionPage(reply: FastifyReply, id: string): string {
  const nonce = randomBytes(18).toString("base64");
  reply
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header(
      "content-security-policy",
      `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    );
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Connected</title><body><p>Return to your Data App.</p><script nonce="${nonce}">if(window.opener)window.opener.postMessage({type:"integration:complete",transactionId:${JSON.stringify(id)}},"*");</script></body></html>`;
}
