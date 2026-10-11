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
  const ask = async (prompt: string) => {
    process.stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    let text = '';
    try {
      for await (const chunk of stdin) {
        for (const ch of chunk.toString('utf8')) {
          if (ch === '\r' || ch === '\n') return text;
          if (ch === '\u0003') process.exit(130);
          if (ch === '\u007f') text = text.slice(0, -1);
          else text += ch;
        }
      }
      return text;
    } finally {
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    }
  };
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
