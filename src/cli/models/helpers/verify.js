import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export async function fileDigest(path, file) {
  const hash = createHash(file.sha256 ? 'sha256' : 'sha1')
  if (file.gitSha1) hash.update(`blob ${file.size}\0`)
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
