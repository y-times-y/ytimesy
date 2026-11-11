import { posixShellQuoted as quote } from "./posix-command";

/**
 * A Claude transcript backup that goes from the VM straight to R2, never
 * through the chat's Durable Object (128 MB, shared with other chats; holding
 * a 12 MB file there ran it out of memory).
 *
 * The object is `YTDIRECT1\n<wrapped key>\n<12-byte IV><AES-256-GCM
 * ciphertext><16-byte tag>`. The Durable Object makes a random data key per
 * upload, hands the VM the key and a presigned URL, and keeps only the key
 * wrapped by the server vault in the object's own header. The VM already holds
 * the transcript in plaintext; what it learns is the one key for this object.
 * The object path is the GCM associated data, so an object cannot be restored
 * under another name.
 */
export const DIRECT_TRANSCRIPT_SUFFIX = ".direct";
export const DIRECT_TRANSCRIPT_MAGIC = "YTDIRECT1";
/** The largest transcript sent this way; a larger one stays on its VM. */
export const MAX_DIRECT_TRANSCRIPT_BYTES = 128 * 1024 * 1024;
/** The header (magic and wrapped key) is read with one small ranged request. */
export const DIRECT_HEADER_READ_BYTES = 4096;

/** What the Durable Object gives the VM for one transfer; written to a 0600 file. */
export type DirectTransferConfig = Readonly<Record<string, string>>;

/** The chat's side of a direct transfer (the Durable Object holds the keys). */
export type DirectTranscriptStore = {
	/** A fresh data key and a presigned PUT, or null when R2 is not configured. */
	readonly prepareUpload: (
		claudeSessionId: string,
	) => Promise<{ path: string; config: DirectTransferConfig } | null>;
	/** The data key unwrapped from the object's header and a presigned GET, or null. */
	readonly prepareDownload: (
		path: string,
	) => Promise<{ config: DirectTransferConfig } | null>;
};

export function isDirectTranscriptPath(path: string | null | undefined) {
	return typeof path === "string" && path.endsWith(DIRECT_TRANSCRIPT_SUFFIX);
}

/**
 * Both scripts take `<config file> <transcript path>`. They read and delete
 * the config first (it holds a presigned URL and the data key), and on any
 * failure say only that it failed: an error from `curl` or `execFileSync`
 * would otherwise carry the signed URL into the turn's logs.
 */
const UPLOAD_SCRIPT = `const fs=require("fs"),crypto=require("crypto"),cp=require("child_process");
const [cfgPath,src]=process.argv.slice(1);
const out=src+".direct.tmp";
try{
const cfg=JSON.parse(fs.readFileSync(cfgPath,"utf8"));
try{fs.unlinkSync(cfgPath)}catch{}
const key=Buffer.from(cfg.dataKey,"base64");
if(key.length!==32||!/^[\\x21-\\x7e]+$/.test(cfg.header))throw 0;
const iv=crypto.randomBytes(12);
const c=crypto.createCipheriv("aes-256-gcm",key,iv);
c.setAAD(Buffer.from(cfg.path));
const fd=fs.openSync(out,"w",0o600);
fs.writeFileSync(fd,${JSON.stringify(`${DIRECT_TRANSCRIPT_MAGIC}\n`)}+cfg.header+"\\n");
fs.writeFileSync(fd,iv);
const input=fs.openSync(src,"r");
const buf=Buffer.alloc(1<<20);
for(let n;(n=fs.readSync(input,buf,0,buf.length,null))>0;)fs.writeFileSync(fd,c.update(buf.subarray(0,n)));
fs.closeSync(input);
fs.writeFileSync(fd,c.final());
fs.writeFileSync(fd,c.getAuthTag());
fs.closeSync(fd);
cp.execFileSync("curl",["--fail","--silent","--show-error","--max-time","600","-X","PUT","--upload-file",out,cfg.url],{stdio:["ignore","ignore","ignore"]});
console.log("uploaded "+fs.statSync(out).size);
}catch{console.error("direct upload failed");process.exitCode=1}
finally{try{fs.unlinkSync(cfgPath)}catch{}try{fs.unlinkSync(out)}catch{}}`;

const DOWNLOAD_SCRIPT = `const fs=require("fs"),crypto=require("crypto"),cp=require("child_process");
const [cfgPath,dest]=process.argv.slice(1);
const tmp=dest+".direct.tmp";
try{
const cfg=JSON.parse(fs.readFileSync(cfgPath,"utf8"));
try{fs.unlinkSync(cfgPath)}catch{}
cp.execFileSync("curl",["--fail","--silent","--show-error","--max-time","600","-o",tmp,cfg.url],{stdio:["ignore","ignore","ignore"]});
const data=fs.readFileSync(tmp);
const l1=data.indexOf(10),l2=data.indexOf(10,l1+1);
if(l1<0||l2<0||data.subarray(0,l1).toString()!==${JSON.stringify(DIRECT_TRANSCRIPT_MAGIC)})throw 0;
const body=data.subarray(l2+1);
if(body.length<28)throw 0;
const d=crypto.createDecipheriv("aes-256-gcm",Buffer.from(cfg.dataKey,"base64"),body.subarray(0,12));
d.setAAD(Buffer.from(cfg.path));
d.setAuthTag(body.subarray(body.length-16));
const plain=Buffer.concat([d.update(body.subarray(12,body.length-16)),d.final()]);
fs.writeFileSync(dest,plain,{mode:0o600});
console.log("restored "+plain.length);
}catch{console.error("direct restore failed");process.exitCode=1}
finally{try{fs.unlinkSync(cfgPath)}catch{}try{fs.unlinkSync(tmp)}catch{}}`;

export const DIRECT_UPLOAD_SCRIPT = UPLOAD_SCRIPT;
export const DIRECT_DOWNLOAD_SCRIPT = DOWNLOAD_SCRIPT;

const NODE = "/usr/local/bin/node";

export function directUploadCommand(
	configPath: string,
	transcriptPath: string,
) {
	return `${NODE} -e ${quote(UPLOAD_SCRIPT)} ${quote(configPath)} ${quote(transcriptPath)}`;
}

export function directDownloadCommand(
	configPath: string,
	transcriptPath: string,
) {
	return `${NODE} -e ${quote(DOWNLOAD_SCRIPT)} ${quote(configPath)} ${quote(transcriptPath)}`;
}
