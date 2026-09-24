// Reading text files the user picks (manuscripts, scripts, tables).

/** UTF-8 (a BOM is dropped), or Shift_JIS for older Japanese files. */
export async function readTextFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('shift_jis').decode(buffer);
  }
}
