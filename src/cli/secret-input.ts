import { readFile } from "node:fs/promises";
import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
export class SecretInputError extends Error {}
export type SecretStream = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
};
export type SecretInput = { stdin?: SecretStream; stderr?: Writable };
async function piped(input: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 65536) throw new SecretInputError("Secret input exceeds 64 KiB");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
async function hidden(input: SecretStream, output: Writable): Promise<string> {
  if (!input.isTTY || !input.setRawMode)
    throw new SecretInputError(
      "Secret entry needs piped stdin, --from-file, --value, or a terminal",
    );
  const wasRaw = input.isRaw ?? false;
  emitKeypressEvents(input);
  output.write("Secret (hidden): ");
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("keypress", keypress);
      input.off("end", ended);
      input.off("error", failed);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write("\n");
    };
    const finish = () => {
      cleanup();
      resolve(value);
    };
    const failed = () => {
      cleanup();
      reject(new SecretInputError("Secret input could not be read"));
    };
    const ended = () => {
      cleanup();
      reject(new SecretInputError("Secret entry ended before submission"));
    };
    const keypress = (text: string | undefined, key: { ctrl?: boolean; name?: string }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new SecretInputError("Secret entry cancelled"));
      } else if ((key.ctrl && key.name === "d") || key.name === "return" || key.name === "enter")
        finish();
      else if (key.name === "backspace") value = [...value].slice(0, -1).join("");
      else if (text && !key.ctrl && !text.startsWith("\u001b")) {
        value += text;
        if (Buffer.byteLength(value) > 65536) {
          cleanup();
          reject(new SecretInputError("Secret input exceeds 64 KiB"));
        }
      }
    };
    input.on("keypress", keypress);
    input.once("end", ended);
    input.once("error", failed);
  });
}
/** File and pipe bytes retain every newline; blank input is rejected, never interpreted as clearing. */
export async function readSecret(
  options: Map<string, string[]>,
  warn: (text: string) => void,
  streams: SecretInput = {},
): Promise<string | null> {
  const input = streams.stdin ?? process.stdin,
    output = streams.stderr ?? process.stderr;
  const names = ["from-file", "value", "clear"].filter((name) => options.has(name));
  if (names.length > 1 || names.some((name) => options.get(name)?.length !== 1))
    throw new SecretInputError("Choose one secret input source");
  const stdin = input.isTTY ? undefined : await piped(input);
  if (names.length && stdin)
    throw new SecretInputError("Piped stdin conflicts with an explicit secret input source");
  if (options.has("clear")) return null;
  let value: string;
  if (options.has("value")) {
    warn("Warning: --value exposes the secret to shell-history and process-list inspection.");
    value = options.get("value")?.[0] as string;
  } else if (options.has("from-file")) {
    try {
      value = await readFile(options.get("from-file")?.[0] as string, "utf8");
    } catch {
      throw new SecretInputError("The secret file could not be read");
    }
  } else value = stdin ?? (await hidden(input, output));
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > 65536)
    throw new SecretInputError("Secret input must contain 1 to 65536 UTF-8 bytes");
  return value;
}
