// Shared model name formatter. Strips org prefix, quant suffix, .gguf extension,
// standalone GGUF token, and separator characters, then lowercases.
export function prettyName(id: string): string {
  return id
    .split("/").pop()!   // drop "org/"
    .split(":")[0]        // drop ":Q4_0" quant suffix
    .replace(/\.gguf$/i, "") // drop .gguf extension
    .replace(/[-_]/g, " ")  // dashes/underscores -> spaces
    .replace(/\bGGUF\b/gi, "") // remove standalone GGUF token
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
