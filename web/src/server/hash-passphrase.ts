// Prints the `hidden.passphraseHash` config value for a passphrase read from stdin.
//   npm run hash-passphrase            (prompts, without echo)
//   printf %s 'passphrase' | npm run -s hash-passphrase
import { hashPassphrase } from './unlock.js';

async function readPassphrase(): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = '';
    for await (const chunk of stdin) text += chunk;
    return text.replace(/\r?\n$/, '');
  }
  // A 'data' listener, not `for await`: leaving a for-await loop early destroys stdin,
  // and the second prompt would then fail with "The operation was aborted".
  const ask = (prompt: string) => new Promise<string>((resolve) => {
    process.stderr.write(prompt);
    let text = '';
    const done = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
      resolve(text);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
  const first = await ask('Passphrase: ');
  if (first !== (await ask('Again: '))) throw new Error('the passphrases do not match');
  return first;
}

const passphrase = await readPassphrase().catch((err: Error) => {
  console.error(`hash-passphrase: ${err.message}`);
  process.exit(1);
});
if (passphrase.length < 8) {
  console.error('hash-passphrase: use at least 8 characters');
  process.exit(1);
}
console.log(await hashPassphrase(passphrase));
