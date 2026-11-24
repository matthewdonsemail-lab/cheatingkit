// Re-index with visible progress and a rate estimate. Progress comes from the embed
// wrapper, which fires per batch, so a long session still reports as it goes.
import { openDatabase } from "./src/cli/storage/client.js";
import { indexSessions, localEmbed } from "./src/cli/search/client.js";

const cwd = process.argv[2] || null;
const db = openDatabase(`${process.env.USERPROFILE}/.cheatingkit/sessions.db`);

const total = db.prepare(
  cwd
    ? "SELECT count(*) n FROM messages m JOIN sessions s ON s.harness=m.harness AND s.sessionId=m.sessionId WHERE m.role IN ('user','assistant') AND lower(replace(rtrim(s.cwd,'/'),char(92),'/'))=lower(replace(rtrim(?, '/'),char(92),'/'))"
    : "SELECT count(*) n FROM messages WHERE role IN ('user','assistant')",
).get(...(cwd ? [cwd] : [])).n;

const started = Date.now();
let done = 0;

const embed = async (texts) => {
  const vectors = await localEmbed(texts);
  done += texts.length;
  const seconds = (Date.now() - started) / 1000;
  const rate = done / seconds;
  const eta = rate > 0.01 ? Math.round((total - done) / rate) : null;
  console.log(`${new Date().toISOString()} embedded=${done}/${total} rate=${rate.toFixed(1)}/s elapsed=${seconds.toFixed(0)}s eta=${eta === null ? "?" : eta + "s"}`);
  return vectors;
};

console.log(`${new Date().toISOString()} start scope=${cwd || "ALL"} messages=${total}`);
const result = await indexSessions(db, () => {}, embed, { cwd });
console.log(`${new Date().toISOString()} result ${JSON.stringify(result)} elapsed=${((Date.now() - started) / 1000).toFixed(0)}s`);

